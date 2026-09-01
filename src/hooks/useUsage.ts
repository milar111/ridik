/**
 * The local usage ledger, as the one screen that discloses it reads it.
 *
 * `app/usage.tsx` is a disclosure surface: the promise it makes is that what a
 * person reads there is exactly what would be uploaded if they ever switched
 * sending on. That only holds if the screen reads the *same* rows the uploader
 * would, so everything here goes straight to `appEvents` and nothing is
 * summarised, rounded or filtered on the way past.
 *
 * **One aggregated query, not a dozen.** The screen asks eleven questions of the
 * same table in one pass — the funnel, four cuts of `turn`, the tool table, the
 * failures, the day strip — and a dozen keys would be a dozen chances for one of
 * them to survive the Clear button and leave a stale count on a page whose whole
 * point is that it is honest. `useToday` is aggregated for the same reason.
 *
 * There is no optimistic path and there must not be one, for the reason
 * `useHistory` has none: a count that briefly shows a number the database does
 * not hold is this screen telling the exact kind of lie it exists to disprove.
 *
 * The *export* half lives in `useUsageExport.ts` and is deliberately not in the
 * `@/hooks` barrel — see the docblock there.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { getRepositories } from '@/repositories';
import type { DayCount, EventCount } from '@/repositories/appEvents';

import { invalidateKeys, qk } from './keys';

/**
 * Every cut of the ledger the Usage screen draws, in one answer.
 *
 * Named per question rather than as a generic map so a section that stops being
 * fetched stops compiling, instead of silently rendering an empty strip.
 */
export type UsageOverview = {
  /** Rows held, and how many of them have never been sent anywhere. */
  totals: { rows: number; unsent: number };
  /** Every event name, most frequent first. */
  byName: EventCount[];
  /** Events per local day, newest day first. */
  byDay: DayCount[];

  /* The funnel through the first utterance. */
  firstRunStep: EventCount[];
  firstRunOutcome: EventCount[];
  firstWordSource: EventCount[];
  firstWordOk: EventCount[];

  /* One turn, four ways. */
  turnStatus: EventCount[];
  turnMode: EventCount[];
  turnInput: EventCount[];
  turnLatency: EventCount[];

  /** Which tools carry the app and which are dead weight. */
  tools: EventCount[];
  /** Why turns failed, from the app's own closed set of reasons. */
  failures: EventCount[];
};

/**
 * The whole ledger, cut every way the screen needs it.
 *
 * Thirteen statements in one round trip. They are independent reads over a
 * table that is at most `RETAIN_ROWS` long, so `Promise.all` is honest here —
 * there is no ordering between them and nothing to interleave.
 */
export function useUsageOverview(): UseQueryResult<UsageOverview> {
  return useQuery({
    queryKey: qk.appEvents.overview(),
    queryFn: async (): Promise<UsageOverview> => {
      const events = getRepositories().appEvents;
      const [
        totals,
        byName,
        byDay,
        firstRunStep,
        firstRunOutcome,
        firstWordSource,
        firstWordOk,
        turnStatus,
        turnMode,
        turnInput,
        turnLatency,
        tools,
        failures,
      ] = await Promise.all([
        events.totals(),
        events.countsByName(),
        events.countsByDay(),
        events.countsByProp('first_run_step', 'step'),
        events.countsByProp('first_run_step', 'outcome'),
        events.countsByProp('first_word', 'source'),
        events.countsByProp('first_word', 'ok'),
        events.countsByProp('turn', 'status'),
        events.countsByProp('turn', 'mode'),
        events.countsByProp('turn', 'input'),
        events.countsByProp('turn', 'latency'),
        events.countsByProp('tool', 'name'),
        events.countsByProp('turn_error', 'code'),
      ]);

      return {
        totals,
        byName,
        byDay,
        firstRunStep,
        firstRunOutcome,
        firstWordSource,
        firstWordOk,
        turnStatus,
        turnMode,
        turnInput,
        turnLatency,
        tools,
        failures,
      };
    },
  });
}

/**
 * Deletes every counted row.
 *
 * Total and immediate, like the history screen's Clear: this is a privacy
 * surface, and a button on one that leaves rows behind is worse than no button.
 * The whole ledger prefix is invalidated rather than the one key, so a future
 * second reader of the same table cannot be left showing what was deleted.
 */
export function useClearUsageLedger(): UseMutationResult<void, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => getRepositories().appEvents.clear(),
    onSettled: () => invalidateKeys(client, [qk.appEvents.all]),
  });
}

export type { AppEvent, DayCount, EventCount } from '@/repositories/appEvents';

/* The retention rule travels with the numbers it bounds. A screen may not reach
   past `@/hooks` into a repository, and "90 days or 5,000 rows" restated as a
   literal on the screen is a sentence that goes quietly wrong the day either
   constant moves. */
export { RETAIN_DAYS, RETAIN_ROWS } from '@/repositories/appEvents';
