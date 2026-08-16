/**
 * Backup and restore, as the screen sees it.
 *
 * Deliberately **not** in the `@/hooks` barrel, for the same reason
 * `useSystem.ts` is not: this reaches the filesystem, the share sheet and the
 * system file picker, and putting it in the barrel would drag all three into
 * the import graph of every screen and every screen test. The one screen that
 * needs it imports it by path.
 *
 * The decision this feature turns on lives in `@/features/export/json`:
 * **a restore merges, it never replaces.** Nothing here may soften that, and
 * `app/backup.tsx` must say it before anything runs.
 */
import Constants from 'expo-constants';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { now } from '@/core/clock';
import { createLogger } from '@/core/logger';
import { unwrap } from '@/core/result';
import {
  applyImport,
  buildBackup,
  countRows,
  deleteBackup,
  listBackups,
  parseBackup,
  pickBackup,
  planImport,
  readBackup,
  saveBackup,
  serialiseBackup,
  shareBackup,
  type Backup,
  type BackupFileInfo,
  type ImportPlan,
  type ImportSummary,
} from '@/features/export';
import { getRepositories } from '@/repositories';

import { invalidateKeys, qk } from './keys';

const log = createLogger('backup');

/** A file that has been read and understood, waiting to be agreed to. */
export type LoadedBackup = { name: string; backup: Backup; plan: ImportPlan; rows: number };

export function useBackups(): UseQueryResult<BackupFileInfo[]> {
  return useQuery({
    queryKey: qk.system.backups(),
    queryFn: () => unwrap(listBackups()),
  });
}

/**
 * Writes the whole database out and hands it to the share sheet.
 *
 * The file is kept either way: a share sheet the user backs out of must not
 * cost them the backup, and a copy on the phone is what makes a restore
 * possible after a mistaken erase.
 */
export function useSaveBackup(): UseMutationResult<BackupFileInfo, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const backup = buildBackup(getRepositories().db.$client, {
        ...(Constants.expoConfig?.version ? { app: Constants.expoConfig.version } : {}),
        at: now(),
      });
      const file = unwrap(saveBackup(serialiseBackup(backup)));
      // Sharing is the optional half. A device with no share sheet still has a
      // backup, and saying otherwise would be a lie about where their data is.
      const shared = await shareBackup(file.uri, 'Ridik backup');
      if (!shared.ok) log.warn('backup saved but not shared', shared.error);
      return file;
    },
    onSettled: () => invalidateKeys(client, [qk.system.backups()]),
  });
}

export function useShareBackup(): UseMutationResult<void, Error, string> {
  return useMutation({
    mutationFn: async (uri: string) => {
      unwrap(await shareBackup(uri));
    },
  });
}

export function useDeleteBackup(): UseMutationResult<void, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (uri: string) => {
      unwrap(deleteBackup(uri));
    },
    onSettled: () => invalidateKeys(client, [qk.system.backups()]),
  });
}

/**
 * Reads a file and works out what restoring it would do — without doing any of
 * it. Nothing is written here; this is the half the confirmation reads from.
 */
export function useLoadBackup(): UseMutationResult<
  LoadedBackup | null,
  Error,
  { uri: string; name: string } | 'pick'
> {
  return useMutation({
    mutationFn: async (source): Promise<LoadedBackup | null> => {
      let name: string;
      let text: string;
      if (source === 'pick') {
        const picked = unwrap(await pickBackup());
        // Cancelling the picker is an answer, not a failure.
        if (!picked) return null;
        name = picked.name;
        text = picked.text;
      } else {
        name = source.name;
        text = unwrap(await readBackup(source.uri));
      }

      const backup = unwrap(parseBackup(text));
      return {
        name,
        backup,
        plan: planImport(getRepositories().db.$client, backup),
        rows: countRows(backup),
      };
    },
  });
}

/**
 * Puts a backup back. Merge, one transaction, nothing deleted.
 *
 * The search index is rebuilt afterwards rather than restored: `notes_fts` is
 * maintained by the notes repository rather than by triggers, so notes that
 * arrive by any other route are invisible to search until it is. A failure
 * there costs searchability, not data, so it must not fail the restore.
 */
export function useRestoreBackup(): UseMutationResult<ImportSummary, Error, Backup> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (backup: Backup) => {
      const repos = getRepositories();
      const summary = unwrap(applyImport(repos.db.$client, backup));
      if (summary.inserted > 0) {
        await repos.notes.rebuildSearchIndex().catch((error: unknown) => {
          log.warn('the search index could not be rebuilt after a restore', error);
        });
      }
      return summary;
    },
    // Every table may have moved, so nothing cached is known to be true.
    onSettled: () => invalidateKeys(client, [qk.all]),
  });
}
