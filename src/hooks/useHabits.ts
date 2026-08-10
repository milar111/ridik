/**
 * Habits and the activity feed they write into.
 *
 * The two live in one file because they are one write: logging a habit inserts
 * an activity row and moves the cached streak, and logging an activity against
 * a habit name recomputes that habit. Splitting them would mean two hooks that
 * always have to be invalidated together anyway — and Today shows both.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { unwrap } from '@/core/result';
import type { LocalDate } from '@/core/time';
import type { ActivityEntry, Habit } from '@/db/schema';
import { getRepositories } from '@/repositories';
import type { ActivityLogInput, ActivitySummary } from '@/repositories/activity';
import type { HabitLogInput, HabitLogResult, HabitOptions } from '@/repositories/habits';

import { invalidateKeys, qk } from './keys';

/** A habit log is an activity entry and a streak change, and Today shows both. */
// Streaks are one of the briefing's three bullets.
const HABIT_WRITE_KEYS = [qk.habits.all, qk.activity.all, qk.today.all, qk.briefing.all] as const;

/* ------------------------------------------------------------------ habits */

export function useHabits(includeArchived = false): UseQueryResult<Habit[]> {
  return useQuery({
    queryKey: qk.habits.list(includeArchived),
    queryFn: () => getRepositories().habits.listHabits({ includeArchived }),
  });
}

export function useHabit(
  id: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<Habit | null> {
  return useQuery({
    queryKey: qk.habits.detail(id ?? ''),
    queryFn: () => getRepositories().habits.habitById(id!),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

/** The days a habit was logged on, ascending — what a streak grid renders. */
export function useHabitHistory(
  id: string | undefined,
  range: { from?: LocalDate; to?: LocalDate } = {},
  options: { enabled?: boolean } = {},
): UseQueryResult<LocalDate[]> {
  return useQuery({
    queryKey: qk.habits.history(id ?? '', range.from ?? null, range.to ?? null),
    queryFn: () => getRepositories().habits.habitHistory(id!, range),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

export function useLogHabit(): UseMutationResult<HabitLogResult, Error, HabitLogInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: HabitLogInput) => getRepositories().habits.logHabit(input),
    onSettled: () => invalidateKeys(client, HABIT_WRITE_KEYS),
  });
}

export function useCreateHabit(): UseMutationResult<
  Habit,
  Error,
  { name: string; options?: HabitOptions }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; options?: HabitOptions }) =>
      getRepositories().habits.getOrCreateHabit(input.name, input.options),
    onSettled: () => invalidateKeys(client, HABIT_WRITE_KEYS),
  });
}

export function useArchiveHabit(): UseMutationResult<
  Habit | null,
  Error,
  { habitId: string; archived?: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { habitId: string; archived?: boolean }) =>
      getRepositories().habits.archiveHabit(input.habitId, input.archived ?? true),
    onSettled: () => invalidateKeys(client, HABIT_WRITE_KEYS),
  });
}

export function useDeleteHabit(): UseMutationResult<boolean, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (habitId: string) => getRepositories().habits.deleteHabit(habitId),
    onSettled: () => invalidateKeys(client, HABIT_WRITE_KEYS),
  });
}

export function useRecomputeHabitStreak(): UseMutationResult<Habit, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (habitId: string) => getRepositories().habits.recomputeStreak(habitId),
    onSettled: () => invalidateKeys(client, HABIT_WRITE_KEYS),
  });
}

export function useResolveHabit(): UseMutationResult<Habit, Error, string> {
  return useMutation({
    mutationFn: async (query: string) =>
      unwrap(await getRepositories().habits.resolveHabit(query)),
  });
}

/* ---------------------------------------------------------------- activity */

export function useRecentActivity(limit = 20): UseQueryResult<ActivityEntry[]> {
  return useQuery({
    queryKey: qk.activity.recent(limit),
    queryFn: () => getRepositories().activity.listRecent(limit),
  });
}

export function useActivityForDate(
  date: LocalDate,
  options: { enabled?: boolean } = {},
): UseQueryResult<ActivityEntry[]> {
  return useQuery({
    queryKey: qk.activity.day(date),
    queryFn: () => getRepositories().activity.listForLocalDate(date),
    enabled: options.enabled ?? true,
  });
}

/** Half-open `[from, to)`, UTC epoch ms. */
export function useActivityBetween(
  from: number,
  to: number,
  options: { enabled?: boolean } = {},
): UseQueryResult<ActivityEntry[]> {
  return useQuery({
    queryKey: qk.activity.between(from, to),
    queryFn: () => getRepositories().activity.listBetween(from, to),
    enabled: options.enabled ?? true,
  });
}

/** Both ends inclusive, local dates — what the activity screen charts. */
export function useActivitySummary(
  range: { from: LocalDate; to: LocalDate },
  options: { enabled?: boolean } = {},
): UseQueryResult<ActivitySummary> {
  return useQuery({
    queryKey: qk.activity.summary(range.from, range.to),
    queryFn: () => getRepositories().activity.summarise(range),
    enabled: options.enabled ?? true,
  });
}

export function useLogActivity(): UseMutationResult<ActivityEntry, Error, ActivityLogInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ActivityLogInput) => getRepositories().activity.log(input),
    // A named habit is created and re-streaked by this write, so habits go too.
    onSettled: () => invalidateKeys(client, [...HABIT_WRITE_KEYS, qk.projects.all]),
  });
}

export function useRemoveActivityEntry(): UseMutationResult<boolean, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getRepositories().activity.removeEntry(id),
    onSettled: () => invalidateKeys(client, HABIT_WRITE_KEYS),
  });
}
