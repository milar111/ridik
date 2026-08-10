/**
 * The recurring weekly programme.
 *
 * Everything derived from it (the next Maths lesson, when homework is due) is
 * computed from "now", so those hooks deliberately take no `from`: a caller
 * passing a drifting instant would produce a new cache key on every render.
 * Editing the timetable changes what Today shows, so both invalidate together.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { unwrap } from '@/core/result';
import { currentZone } from '@/core/time';
import type { CurriculumEntry } from '@/db/schema';
import { getRepositories } from '@/repositories';
import type {
  ClassOccurrence,
  CurriculumEntryInput,
  CurriculumEntryPatch,
  HomeworkDueDate,
  NextClass,
} from '@/repositories/curriculum';

import { invalidateKeys, qk } from './keys';

/** The timetable is half of what Today lists. */
const CURRICULUM_WRITE_KEYS = [qk.curriculum.all, qk.today.all] as const;

/* ------------------------------------------------------------------- reads */

export function useCurriculumEntries(activeOnly = false): UseQueryResult<CurriculumEntry[]> {
  return useQuery({
    queryKey: qk.curriculum.entries(activeOnly),
    queryFn: () => getRepositories().curriculum.listEntries({ activeOnly }),
  });
}

/** 0 = Sunday .. 6 = Saturday, matching the schema. */
export function useCurriculumDay(
  dayOfWeek: number,
  options: { activeOnly?: boolean; enabled?: boolean } = {},
): UseQueryResult<CurriculumEntry[]> {
  const activeOnly = options.activeOnly ?? true;
  return useQuery({
    queryKey: qk.curriculum.day(dayOfWeek, activeOnly),
    queryFn: () => getRepositories().curriculum.entriesForDay(dayOfWeek, { activeOnly }),
    enabled: options.enabled ?? true,
  });
}

export function useCurriculumSubjects(): UseQueryResult<string[]> {
  return useQuery({
    queryKey: qk.curriculum.subjects(),
    queryFn: () => getRepositories().curriculum.distinctSubjects(),
  });
}

export function useUpcomingClasses(
  options: { from?: number; days?: number; zone?: string; enabled?: boolean } = {},
): UseQueryResult<ClassOccurrence[]> {
  const zone = options.zone ?? currentZone();
  const days = options.days ?? 7;
  return useQuery({
    queryKey: qk.curriculum.upcoming(options.from ?? null, days, zone),
    queryFn: () =>
      getRepositories().curriculum.upcomingOccurrences({ from: options.from, days, zone }),
    enabled: options.enabled ?? true,
  });
}

export function useNextClass(
  subject: string | undefined,
  options: { zone?: string; enabled?: boolean } = {},
): UseQueryResult<NextClass> {
  const zone = options.zone ?? currentZone();
  return useQuery({
    queryKey: qk.curriculum.next(subject ?? '', zone),
    queryFn: async () =>
      unwrap(await getRepositories().curriculum.nextOccurrenceOf(subject!, { zone })),
    enabled: (options.enabled ?? true) && Boolean(subject),
  });
}

/** "One day before the next lesson", clamped so it is never already past. */
export function useHomeworkDueDate(
  subject: string | undefined,
  options: { hoursBefore?: number; zone?: string; enabled?: boolean } = {},
): UseQueryResult<HomeworkDueDate> {
  const zone = options.zone ?? currentZone();
  return useQuery({
    queryKey: qk.curriculum.homeworkDue(subject ?? '', options.hoursBefore ?? null, zone),
    queryFn: async () =>
      unwrap(
        await getRepositories().curriculum.dueDateForHomework(subject!, {
          zone,
          hoursBefore: options.hoursBefore,
        }),
      ),
    enabled: (options.enabled ?? true) && Boolean(subject),
  });
}

/* ------------------------------------------------------------------ writes */

export function useAddCurriculumEntries(): UseMutationResult<
  CurriculumEntry[],
  Error,
  CurriculumEntryInput[]
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (entries: CurriculumEntryInput[]) =>
      getRepositories().curriculum.addEntries(entries),
    onSettled: () => invalidateKeys(client, CURRICULUM_WRITE_KEYS),
  });
}

/** Whole-timetable swap — the old programme never survives a failure. */
export function useReplaceCurriculum(): UseMutationResult<
  CurriculumEntry[],
  Error,
  CurriculumEntryInput[]
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (entries: CurriculumEntryInput[]) =>
      getRepositories().curriculum.replaceAll(entries),
    onSettled: () => invalidateKeys(client, CURRICULUM_WRITE_KEYS),
  });
}

export function useUpdateCurriculumEntry(): UseMutationResult<
  CurriculumEntry,
  Error,
  { id: string; patch: CurriculumEntryPatch }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: CurriculumEntryPatch }) =>
      unwrap(await getRepositories().curriculum.updateEntry(input.id, input.patch)),
    onSettled: () => invalidateKeys(client, CURRICULUM_WRITE_KEYS),
  });
}

export function useDeleteCurriculumEntry(): UseMutationResult<boolean, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getRepositories().curriculum.deleteEntry(id),
    onSettled: () => invalidateKeys(client, CURRICULUM_WRITE_KEYS),
  });
}

export function useResolveSubject(): UseMutationResult<string, Error, string> {
  return useMutation({
    mutationFn: async (query: string) =>
      unwrap(await getRepositories().curriculum.resolveSubject(query)),
  });
}
