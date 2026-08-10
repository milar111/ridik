/**
 * Structured notes and their bullets.
 *
 * Ticking a bullet is spec 5.4 instant: the checkbox flips in the cache before
 * the write is issued and rolls back if the row has gone. The optimistic patch
 * is shape-driven because the same note is cached three ways at once — inside a
 * list, as a detail, and inside a search hit.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { unwrap } from '@/core/result';
import type { NoteBullet } from '@/db/schema';
import { getRepositories } from '@/repositories';
import type {
  BulletInput,
  BulletKind,
  ListNotesOptions,
  NotePatch,
  NoteSearchHit,
  NoteWithBullets,
  ResolveNoteOptions,
  TagCount,
  UpsertNoteInput,
} from '@/repositories/notes';

import {
  cancelKeys,
  invalidateKeys,
  qk,
  restoreQueries,
  snapshotQueries,
  type QuerySnapshot,
} from './keys';

/** A note can be filed under a project, and the overview lists it. */
const NOTE_WRITE_KEYS = [qk.notes.all, qk.projects.all] as const;

/* ------------------------------------------------------------------- reads */

export function useNotes(options: ListNotesOptions = {}): UseQueryResult<NoteWithBullets[]> {
  return useQuery({
    queryKey: qk.notes.list(options),
    queryFn: () => getRepositories().notes.listNotes(options),
  });
}

export function useNote(
  id: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<NoteWithBullets | null> {
  return useQuery({
    queryKey: qk.notes.detail(id ?? ''),
    queryFn: () => getRepositories().notes.getNote(id!),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

export function useNoteTags(includeArchived = false): UseQueryResult<TagCount[]> {
  return useQuery({
    queryKey: qk.notes.tags(includeArchived),
    queryFn: () => getRepositories().notes.listTags({ includeArchived }),
  });
}

export function useNoteSearch(
  query: string,
  options: { limit?: number; includeArchived?: boolean; enabled?: boolean } = {},
): UseQueryResult<NoteSearchHit[]> {
  const limit = options.limit ?? 20;
  const includeArchived = options.includeArchived ?? false;
  const trimmed = query.trim();
  return useQuery({
    queryKey: qk.notes.search(trimmed, limit, includeArchived),
    queryFn: () => getRepositories().notes.searchNotes(trimmed, limit, { includeArchived }),
    enabled: (options.enabled ?? true) && trimmed.length > 0,
  });
}

/* --------------------------------------------------------------- optimism */

function isNoteWithBullets(value: unknown): value is NoteWithBullets {
  return (
    typeof value === 'object' &&
    value !== null &&
    'titleSummary' in value &&
    'bullets' in value &&
    Array.isArray((value as { bullets: unknown }).bullets)
  );
}

function isSearchHit(value: unknown): value is NoteSearchHit {
  return typeof value === 'object' && value !== null && 'note' in value && 'score' in value;
}

/**
 * Flips one bullet wherever it is cached, leaving every other shape alone.
 * `completed` undefined means "toggle", the same as the repository's default.
 */
function patchBulletInCache(value: unknown, bulletId: string, completed?: boolean): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const patched = patchBulletInCache(entry, bulletId, completed);
      if (patched !== entry) changed = true;
      return patched;
    });
    return changed ? next : value;
  }

  if (isSearchHit(value)) {
    const note = patchBulletInCache(value.note, bulletId, completed);
    return note === value.note ? value : { ...value, note };
  }

  if (isNoteWithBullets(value)) {
    let changed = false;
    const bullets: NoteBullet[] = value.bullets.map((bullet) => {
      if (bullet.id !== bulletId) return bullet;
      changed = true;
      // Checking something off is what turns a plain bullet into a checkbox —
      // the same rule the repository applies.
      return { ...bullet, isCompleted: completed ?? !bullet.isCompleted, bulletKind: 'todo' };
    });
    return changed ? { ...value, bullets } : value;
  }

  return value;
}

type OptimisticContext = { previous: QuerySnapshot };

/* ------------------------------------------------------------------ writes */

export function useUpsertNote(): UseMutationResult<NoteWithBullets, Error, UpsertNoteInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertNoteInput) => getRepositories().notes.upsertNoteWithBullets(input),
    onSettled: () => invalidateKeys(client, NOTE_WRITE_KEYS),
  });
}

export function useAppendNoteBullets(): UseMutationResult<
  NoteWithBullets,
  Error,
  { noteId: string; contents: BulletInput[]; kind?: BulletKind }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { noteId: string; contents: BulletInput[]; kind?: BulletKind }) =>
      unwrap(
        await getRepositories().notes.appendBullets(input.noteId, input.contents, input.kind),
      ),
    onSettled: () => invalidateKeys(client, NOTE_WRITE_KEYS),
  });
}

export function useUpdateNote(): UseMutationResult<
  NoteWithBullets,
  Error,
  { id: string; patch: NotePatch }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: NotePatch }) =>
      unwrap(await getRepositories().notes.updateNote(input.id, input.patch)),
    onSettled: () => invalidateKeys(client, NOTE_WRITE_KEYS),
  });
}

export function useDeleteNote(): UseMutationResult<
  { id: string; titleSummary: string },
  Error,
  { id: string; confirmed?: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; confirmed?: boolean }) =>
      unwrap(
        await getRepositories().notes.deleteNote(input.id, { confirmed: input.confirmed ?? true }),
      ),
    onSettled: () => invalidateKeys(client, NOTE_WRITE_KEYS),
  });
}

export function useArchiveNote(): UseMutationResult<
  NoteWithBullets,
  Error,
  { id: string; archived?: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; archived?: boolean }) => {
      const notes = getRepositories().notes;
      const archived = input.archived ?? true;
      return unwrap(await (archived ? notes.softArchive(input.id) : notes.unarchiveNote(input.id)));
    },
    onSettled: () => invalidateKeys(client, NOTE_WRITE_KEYS),
  });
}

/** Spec 5.4: the tick lands before the database does. */
export function useToggleNoteBullet(): UseMutationResult<
  NoteBullet,
  Error,
  { bulletId: string; completed?: boolean },
  OptimisticContext
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { bulletId: string; completed?: boolean }) =>
      unwrap(await getRepositories().notes.toggleBullet(input.bulletId, input.completed)),
    onMutate: async (input) => {
      await cancelKeys(client, [qk.notes.all]);
      const previous = snapshotQueries(client, [qk.notes.all]);
      client.setQueriesData<unknown>({ queryKey: qk.notes.all }, (data: unknown) =>
        patchBulletInCache(data, input.bulletId, input.completed),
      );
      return { previous };
    },
    onError: (_error, _input, context) => restoreQueries(client, context?.previous),
    onSettled: () => invalidateKeys(client, [qk.notes.all]),
  });
}

export function useUpdateNoteBullet(): UseMutationResult<
  NoteBullet,
  Error,
  { bulletId: string; content: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { bulletId: string; content: string }) =>
      unwrap(await getRepositories().notes.updateBullet(input.bulletId, input.content)),
    onSettled: () => invalidateKeys(client, [qk.notes.all]),
  });
}

export function useRemoveNoteBullet(): UseMutationResult<{ id: string }, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (bulletId: string) =>
      unwrap(await getRepositories().notes.removeBullet(bulletId)),
    onSettled: () => invalidateKeys(client, [qk.notes.all]),
  });
}

export function useReorderNoteBullets(): UseMutationResult<
  NoteBullet[],
  Error,
  { noteId: string; orderedIds: string[] }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { noteId: string; orderedIds: string[] }) =>
      unwrap(await getRepositories().notes.reorderBullets(input.noteId, input.orderedIds)),
    onSettled: () => invalidateKeys(client, [qk.notes.all]),
  });
}

export function useResolveNote(): UseMutationResult<
  NoteWithBullets,
  Error,
  { query: string; options?: ResolveNoteOptions }
> {
  return useMutation({
    mutationFn: async ({ query, options }: { query: string; options?: ResolveNoteOptions }) =>
      unwrap(await getRepositories().notes.resolveNote(query, options)),
  });
}

/** Maintenance: repopulates `notes_fts` when search starts looking wrong. */
export function useRebuildNoteSearchIndex(): UseMutationResult<number, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => getRepositories().notes.rebuildSearchIndex(),
    onSettled: () => invalidateKeys(client, [qk.notes.all]),
  });
}
