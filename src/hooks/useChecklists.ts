/**
 * Checklists — the fastest-moving surface in the app.
 *
 * The repository only ever ticks an item off by *words* (`toggle` resolves the
 * spoken phrase), because voice is the only handle it was designed for. A tap
 * knows exactly which row it hit, so the mutation carries `itemId` purely to
 * aim the optimistic patch; the repository still receives the contract shape it
 * expects, and the id never reaches it.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { now } from '@/core/clock';
import { normalise } from '@/core/match';
import { unwrap } from '@/core/result';
import type { ChecklistItem } from '@/db/schema';
import { getRepositories } from '@/repositories';
import type {
  AddItemsResult,
  ChecklistItemInput,
  ChecklistItemPatch,
  ChecklistListSummary,
  ChecklistToggleInput,
} from '@/repositories/checklists';

import {
  cancelKeys,
  invalidateKeys,
  qk,
  restoreQueries,
  snapshotQueries,
  type QuerySnapshot,
} from './keys';

/** An item can be filed under a project, whose overview lists it. */
const CHECKLIST_WRITE_KEYS = [qk.checklists.all, qk.projects.all] as const;

/* ------------------------------------------------------------------- reads */

export function useChecklistNames(): UseQueryResult<ChecklistListSummary[]> {
  return useQuery({
    queryKey: qk.checklists.names(),
    queryFn: () => getRepositories().checklists.listNames(),
  });
}

export function useChecklistItems(
  listName: string | undefined,
  options: { includeCompleted?: boolean; enabled?: boolean } = {},
): UseQueryResult<ChecklistItem[]> {
  const includeCompleted = options.includeCompleted ?? true;
  return useQuery({
    queryKey: qk.checklists.items(listName ?? '', includeCompleted),
    queryFn: () =>
      getRepositories().checklists.itemsForList(listName!, { includeCompleted }),
    enabled: (options.enabled ?? true) && Boolean(listName),
  });
}

export function useChecklistItem(
  id: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<ChecklistItem | null> {
  return useQuery({
    queryKey: qk.checklists.detail(id ?? ''),
    queryFn: () => getRepositories().checklists.itemById(id!),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

/* --------------------------------------------------------------- optimism */

function isChecklistRow(value: unknown): value is ChecklistItem {
  return (
    typeof value === 'object' && value !== null && 'itemText' in value && 'listName' in value
  );
}

export type ToggleChecklistItemInput = ChecklistToggleInput & {
  /** UI-only: the exact row the user tapped, so the optimistic patch cannot miss. */
  itemId?: string;
};

function patchChecklistInCache(
  data: unknown,
  input: ToggleChecklistItemInput,
  completed: boolean,
): unknown {
  if (!Array.isArray(data)) return data;
  const wanted = normalise(input.itemQuery);
  let changed = false;
  const next = data.map((row) => {
    if (!isChecklistRow(row)) return row;
    const hit = input.itemId
      ? row.id === input.itemId
      : normalise(row.itemText) === wanted &&
        (!input.listName || normalise(row.listName) === normalise(input.listName));
    if (!hit || Boolean(row.isCompleted) === completed) return row;
    changed = true;
    return { ...row, isCompleted: completed, completedAt: completed ? now() : null };
  });
  return changed ? next : data;
}

type OptimisticContext = { previous: QuerySnapshot };

/* ------------------------------------------------------------------ writes */

export function useAddChecklistItems(): UseMutationResult<
  AddItemsResult,
  Error,
  { listName: string; items: ChecklistItemInput[]; projectId?: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { listName: string; items: ChecklistItemInput[]; projectId?: string }) =>
      getRepositories().checklists.addItems(input.listName, input.items, input.projectId),
    onSettled: () => invalidateKeys(client, CHECKLIST_WRITE_KEYS),
  });
}

/** Spec 5.4: the row crosses out on tap, not on commit. */
export function useToggleChecklistItem(): UseMutationResult<
  ChecklistItem,
  Error,
  ToggleChecklistItemInput,
  OptimisticContext
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: ToggleChecklistItemInput) =>
      unwrap(
        await getRepositories().checklists.toggle({
          listName: input.listName,
          itemQuery: input.itemQuery,
          completed: input.completed,
        }),
      ),
    onMutate: async (input) => {
      await cancelKeys(client, [qk.checklists.all]);
      const previous = snapshotQueries(client, [qk.checklists.all]);
      // Matches the repository's own default: an unqualified toggle ticks off.
      const completed = input.completed ?? true;
      client.setQueriesData<unknown>({ queryKey: qk.checklists.all }, (data: unknown) =>
        patchChecklistInCache(data, input, completed),
      );
      return { previous };
    },
    onError: (_error, _input, context) => restoreQueries(client, context?.previous),
    onSettled: () => invalidateKeys(client, CHECKLIST_WRITE_KEYS),
  });
}

export function useUpdateChecklistItem(): UseMutationResult<
  ChecklistItem | null,
  Error,
  { id: string; patch: ChecklistItemPatch }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; patch: ChecklistItemPatch }) =>
      getRepositories().checklists.updateItem(input.id, input.patch),
    onSettled: () => invalidateKeys(client, CHECKLIST_WRITE_KEYS),
  });
}

export function useRemoveChecklistItem(): UseMutationResult<boolean, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getRepositories().checklists.removeItem(id),
    onSettled: () => invalidateKeys(client, CHECKLIST_WRITE_KEYS),
  });
}

export function useClearCompletedChecklistItems(): UseMutationResult<number, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (listName: string) => getRepositories().checklists.clearCompleted(listName),
    onSettled: () => invalidateKeys(client, CHECKLIST_WRITE_KEYS),
  });
}

export function useRenameChecklist(): UseMutationResult<
  number,
  Error,
  { from: string; to: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      getRepositories().checklists.renameList(input.from, input.to),
    onSettled: () => invalidateKeys(client, CHECKLIST_WRITE_KEYS),
  });
}
