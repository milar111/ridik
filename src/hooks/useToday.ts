/**
 * The Today screen's entire data set, in one query.
 *
 * Twelve independent `useQuery` calls would mean twelve loading states, twelve
 * error states and a screen that assembles itself in front of the user. It also
 * costs twelve invalidations after every voice utterance. So Today is a single
 * aggregate read keyed on the local day it is showing — which also makes the
 * midnight rollover a key change rather than a bug.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { now } from '@/core/clock';
import { createLogger } from '@/core/logger';
import { currentZone, dayRange, localDateOf, type LocalDate } from '@/core/time';
import type {
  ActivityEntry,
  CalendarEvent,
  FocusSession,
  Habit,
  Task,
} from '@/db/schema';
import { getRepositories } from '@/repositories';
import type { CommitmentWithEntity } from '@/repositories/crm';
import type { ClassOccurrence } from '@/repositories/curriculum';
import { computeSessionState, type SessionState } from '@/repositories/focusSessions';

import { qk } from './keys';

const log = createLogger('hooks/today');

export type TodayHabit = {
  habit: Habit;
  /** Read off the cached streak rather than a per-habit history query. */
  loggedToday: boolean;
  streak: number;
};

export type TodayFocus = { session: FocusSession; state: SessionState };

export type TodaySync = {
  pending: number;
  inFlight: number;
  failed: number;
  /** What the badge shows: everything that has not reached the server yet. */
  badge: number;
};

export type TodaySnapshot = {
  date: LocalDate;
  zone: string;
  /** The instant the snapshot was assembled. */
  at: number;
  dayStart: number;
  /** Exclusive — the start of tomorrow. */
  dayEnd: number;
  events: CalendarEvent[];
  classes: ClassOccurrence[];
  /** Due at some point today. */
  dueTasks: Task[];
  /** Was due before today and still open. */
  overdueTasks: Task[];
  habits: TodayHabit[];
  commitments: CommitmentWithEntity[];
  focus: TodayFocus | null;
  sync: TodaySync;
  activity: ActivityEntry[];
};

export type UseTodayOptions = {
  /** Defaults to the device zone. */
  zone?: string;
  enabled?: boolean;
  /** Keeps a running focus session honest without the screen owning a timer. */
  refetchIntervalMs?: number;
};

/**
 * An unreadable phase plan costs the user their timer card, not the whole
 * screen — every other section of Today is unaffected by it.
 */
function describeSession(session: FocusSession, at: number): TodayFocus | null {
  try {
    return { session, state: computeSessionState(session, at) };
  } catch (error) {
    log.warn('Unreadable focus session plan', { id: session.id, error });
    return null;
  }
}

export async function loadToday(date: LocalDate, zone: string): Promise<TodaySnapshot> {
  const repos = getRepositories();
  const at = now();
  const { start, end } = dayRange(date, zone);

  const [events, classes, dated, habitRows, commitments, session, sync, activity] =
    await Promise.all([
      repos.calendar.listForLocalDate(date, zone),
      repos.curriculum.upcomingOccurrences({ from: start, days: 1, zone }),
      // `dueBefore` is exclusive and drops undated rows, so this is exactly
      // "everything with a deadline that has not passed midnight tonight".
      repos.tasks.listActiveTasks({ dueBefore: end }),
      repos.habits.listHabits(),
      repos.crm.listOpenCommitments({ dueBefore: end }),
      repos.focus.getActive(),
      repos.syncQueue.counts(),
      repos.activity.listForLocalDate(date),
    ]);

  const overdueTasks = dated.filter((task) => task.dueDate !== null && task.dueDate < start);
  const dueTasks = dated.filter((task) => task.dueDate !== null && task.dueDate >= start);

  return {
    date,
    zone,
    at,
    dayStart: start,
    dayEnd: end,
    events,
    classes,
    dueTasks,
    overdueTasks,
    habits: habitRows.map((habit) => ({
      habit,
      loggedToday: habit.lastCompletedDate === date,
      streak: habit.currentStreak ?? 0,
    })),
    commitments,
    focus: session ? describeSession(session, at) : null,
    sync: {
      ...sync,
      badge: sync.pending + sync.inFlight + sync.failed,
    },
    activity,
  };
}

export function useToday(options: UseTodayOptions = {}): UseQueryResult<TodaySnapshot> {
  const zone = options.zone ?? currentZone();
  // Stable for the whole day, so this is a key that rolls over rather than a
  // render-time value that thrashes the cache.
  const date = localDateOf(now(), zone);

  return useQuery({
    queryKey: qk.today.snapshot(date, zone),
    queryFn: () => loadToday(date, zone),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchIntervalMs,
  });
}
