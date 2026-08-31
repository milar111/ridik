/**
 * The three things the home-screen widgets need that no screen does.
 *
 * Today's snapshot answers "what is happening now"; the widgets also draw a
 * whole month, five weeks of habit history, and whether each part of the app
 * has ever been used at all. None of those belong on `useToday`, which every
 * screen depends on and which would then refetch a month of events whenever the
 * user ticked a task.
 *
 * Kept as one hook so the publisher has one thing to wait for, and so the
 * "have these settled" question is answered in the same place it is asked.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { DateTime, localDateOf, monthRange } from '@/core/time';
import type { MonthInterval } from '@/services/widgets/snapshot';
import type { LocalDate } from '@/core/time';
import { getRepositories } from '@/repositories';
import { HABIT_HISTORY_DAYS } from '@/services/widgets/snapshot';
import { qk } from './keys';

export type WidgetSources = {
  monthEvents: MonthInterval[];
  habitHistory: Record<string, LocalDate[]>;
  counts: { events: number; tasks: number; habits: number; lists: number } | undefined;
  /**
   * Whether every source has *answered* — succeeded or failed.
   *
   * Not "succeeded": one failing query must not hold five widgets hostage on a
   * face that says "no lists yet" over a list that exists.
   */
  settled: boolean;
};

export type UseWidgetSourcesInput = {
  /** The day the snapshot describes, so the month and the rails agree with it. */
  date: LocalDate | undefined;
  zone: string | undefined;
  /** Habit ids, in the order the rails will draw them. */
  habitIds: readonly string[];
};

export function useWidgetSources({ date, zone, habitIds }: UseWidgetSourcesInput): WidgetSources {
  const enabled = Boolean(date && zone);

  const month = useMemo(() => {
    if (!date || !zone) return null;
    // Anchored at noon, because some zones have no midnight on the day the
    // clocks go forward and `monthRange` would land in the previous month.
    const range = monthRange(Date.parse(`${date}T12:00:00Z`), zone);

    // Widened to cover the current week as well as the month, because they are
    // not the same span: a week straddling the 1st has days in the month either
    // side. The Chain face draws all seven, and a day this query did not load
    // is drawn `cold` — which is indistinguishable from "free", so the tile
    // would report an empty Monday it knows nothing about.
    const todayNoon = DateTime.fromISO(`${date}T12:00`, { zone });
    const weekStart = todayNoon.startOf('week').startOf('day');

    return {
      start: Math.min(range.start, weekStart.toMillis()),
      end: Math.max(range.end, weekStart.plus({ days: 7 }).toMillis()),
    };
  }, [date, zone]);

  /**
   * Everything that occupies time this month — events *and* classes.
   *
   * Both, because the plate's question is "is the 19th free" and a timetabled
   * Monday is not free. Counting only calendar rows drew an empty week for
   * anyone whose week is lessons, which is this app's central user.
   *
   * Filed under the calendar's own key so an event write already invalidates
   * it; a timetable edit is rare enough that the next publish catching it is
   * soon enough.
   */
  const events = useQuery({
    queryKey: qk.calendar.range(month?.start ?? 0, month?.end ?? 0),
    queryFn: async (): Promise<MonthInterval[]> => {
      const repos = getRepositories();
      const days = Math.round((month!.end - month!.start) / 86_400_000);
      const [rows, classes] = await Promise.all([
        repos.calendar.listBetween(month!.start, month!.end),
        repos.curriculum.upcomingOccurrences({ from: month!.start, days, zone }),
      ]);
      return [
        ...rows.map((row) => ({ startsAt: row.startsAt, endsAt: row.endsAt, allDay: row.allDay })),
        ...classes.map((c) => ({ startsAt: c.startsAt, endsAt: c.endsAt, allDay: false })),
      ];
    },
    enabled: enabled && month != null,
  });

  const history = useQuery({
    queryKey: qk.habits.historyAll(habitIds, historyStart(date), date ?? ''),
    queryFn: async () => {
      const repos = getRepositories();
      const from = historyStart(date);
      const pairs = await Promise.all(
        habitIds.map(
          async (id) => [id, await repos.habits.habitHistory(id, { from, to: date! })] as const,
        ),
      );
      return Object.fromEntries(pairs) as Record<string, LocalDate[]>;
    },
    enabled: enabled && habitIds.length > 0,
  });

  /**
   * Has each area ever been used — which flips at most once in a user's life.
   *
   * Polled rather than invalidated. It would otherwise have to hang off every
   * write key in the app, and being a minute late to notice someone's first
   * task is not a defect worth that much plumbing. A count over an index is
   * cheaper than the render it feeds.
   */
  const counts = useQuery({
    queryKey: qk.widgets.usage(),
    queryFn: () => getRepositories().usage.counts(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  return {
    monthEvents: events.data ?? [],
    habitHistory: history.data ?? {},
    counts: counts.data,
    settled:
      !enabled ||
      (!events.isPending && !counts.isPending && (habitIds.length === 0 || !history.isPending)),
  };
}

/** The oldest day any rail draws. */
function historyStart(date: LocalDate | undefined): LocalDate {
  if (!date) return '';
  const end = Date.parse(`${date}T12:00:00Z`);
  return localDateOf(end - (HABIT_HISTORY_DAYS - 1) * 86_400_000, 'UTC');
}
