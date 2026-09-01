/**
 * Getting the usage ledger off the phone, with no network anywhere near it.
 *
 * Deliberately **not** in the `@/hooks` barrel, for exactly the reason
 * `useBackup.ts` is not: this reaches `@/features/export`, which loads
 * expo-file-system, expo-sharing, expo-print, expo-mail-composer and
 * expo-clipboard at module scope. Putting it in the barrel would drag all five
 * into the import graph of every screen and every screen test. The one screen
 * that needs it imports it by path; the *reading* half is in `useUsage.ts` and
 * is barrel-exported normally.
 *
 * **The file is the upload, written to disk instead.** `UploadableEvent` is the
 * shape `appEvents.unsent()` hands to a server: no `id`, no `created_at`, the
 * local date as the finest time that travels. This writes that, row for row, so
 * a beta tester mailing the operator a file is not disclosing anything the
 * Usage screen did not already show them — and the operator gets real answers
 * from a build where sending is switched off entirely.
 *
 * It goes out through `shareAsFile`, the same cache-file-plus-share-sheet path
 * every other export in the app uses. Not `saveBackup`: that writes into the
 * `backups/` folder, where a usage export would appear in the restore picker as
 * a backup and be refused by name the moment somebody tapped it.
 */
import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { now } from '@/core/clock';
import { currentZone, localDateOf, type LocalDate } from '@/core/time';
import { shareAsFile, type ShareOutcome } from '@/features/export';
import { getRepositories } from '@/repositories';
import { RETAIN_DAYS, RETAIN_ROWS, type AppEvent, type UploadableEvent } from '@/repositories/appEvents';

/** Bumped if the envelope ever changes shape, so a reader can refuse an unknown one. */
export const USAGE_EXPORT_FORMAT = 'ridik.usage';
export const USAGE_EXPORT_VERSION = 1;

export type UsageExport = {
  format: typeof USAGE_EXPORT_FORMAT;
  version: number;
  /**
   * A local *date*, not a timestamp.
   *
   * The events themselves carry nothing finer than a day, and stamping the
   * envelope to the second would put a more precise fact about this person in
   * the file than any row in it — in the one document whose claim is that it
   * holds nothing the screen did not show.
   */
  exported_on: LocalDate;
  retention: { days: number; rows: number };
  totals: { rows: number; unsent: number };
  events: UploadableEvent[];
};

/**
 * The document, as a pure function of what was read. No clock, no filesystem.
 *
 * `id` and `createdAt` are dropped here rather than in the query, so the one
 * place that decides what travels is the one place that says so.
 */
export function usageExportDocument(
  events: readonly AppEvent[],
  totals: { rows: number; unsent: number },
  on: LocalDate,
): UsageExport {
  return {
    format: USAGE_EXPORT_FORMAT,
    version: USAGE_EXPORT_VERSION,
    exported_on: on,
    retention: { days: RETAIN_DAYS, rows: RETAIN_ROWS },
    totals,
    events: events.map((event) => ({
      name: event.name,
      props: event.props,
      local_date: event.localDate,
    })),
  };
}

export function usageExportFilename(on: LocalDate): string {
  return `ridik-usage-${on}.json`;
}

/**
 * Writes the whole ledger out as JSON and offers it to the share sheet.
 *
 * `RETAIN_ROWS` as the limit rather than `recent()`'s default 200: the ring is
 * bounded at exactly that, so this is "everything" stated as a number the
 * repository already guarantees, and a truncated export of a privacy disclosure
 * would be the worst possible kind of half-truth.
 */
export function useExportUsage(): UseMutationResult<ShareOutcome, Error, void> {
  return useMutation({
    mutationFn: async () => {
      const repo = getRepositories().appEvents;
      const [events, totals] = await Promise.all([repo.recent(RETAIN_ROWS), repo.totals()]);
      const on = localDateOf(now(), currentZone());

      const document = usageExportDocument(events, totals, on);
      const shared = await shareAsFile(
        `${JSON.stringify(document, null, 2)}\n`,
        usageExportFilename(on),
        {
          dialogTitle: 'Ridik usage',
          mimeType: 'application/json',
          uti: 'public.json',
        },
      );
      if (!shared.ok) throw shared.error;
      return shared.value;
    },
  });
}
