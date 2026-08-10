/**
 * The local calendar mirror, plus the outbox that drains it.
 *
 * Every calendar write lands locally as `pending` and is pushed later, so a
 * write changes two things the user can see: the day it is on, and the sync
 * badge on Today. Both are invalidated together — a badge that only updates on
 * the next app launch is worse than no badge.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { now } from '@/core/clock';
import { unwrap } from '@/core/result';
import { currentZone, localDateOf, type LocalDate } from '@/core/time';
import type { CalendarEvent } from '@/db/schema';
import { getRepositories } from '@/repositories';
import type {
  ConflictQuery,
  CreateEventInput,
  CreateEventWithBufferInput,
  ResolveEventQuery,
  SyncTarget,
  TimeSlot,
  UpdateEventPatch,
} from '@/repositories/calendarEvents';
import type { SyncQueueEntry, SyncStatus } from '@/repositories/syncQueue';

import { invalidateKeys, qk } from './keys';

/** A calendar write moves the day view, Today, and the outbox badge. */
const CALENDAR_WRITE_KEYS = [qk.calendar.all, qk.today.all, qk.sync.all] as const;

/* --------------------------------------------------------------- calendar */

export function useCalendarDay(
  date: LocalDate,
  options: { zone?: string; includeDeleted?: boolean; enabled?: boolean } = {},
): UseQueryResult<CalendarEvent[]> {
  const zone = options.zone ?? currentZone();
  return useQuery({
    queryKey: qk.calendar.day(date, zone),
    queryFn: () =>
      getRepositories().calendar.listForLocalDate(date, zone, {
        includeDeleted: options.includeDeleted,
      }),
    enabled: options.enabled ?? true,
  });
}

export function useCalendarToday(
  options: { zone?: string; enabled?: boolean } = {},
): UseQueryResult<CalendarEvent[]> {
  const zone = options.zone ?? currentZone();
  return useCalendarDay(localDateOf(now(), zone), { ...options, zone });
}

/** Half-open `[from, to)`, UTC epoch ms — what a week or month grid asks for. */
export function useCalendarRange(
  from: number,
  to: number,
  options: { includeDeleted?: boolean; enabled?: boolean } = {},
): UseQueryResult<CalendarEvent[]> {
  const includeDeleted = options.includeDeleted ?? false;
  return useQuery({
    queryKey: qk.calendar.range(from, to, includeDeleted),
    queryFn: () => getRepositories().calendar.listBetween(from, to, { includeDeleted }),
    enabled: options.enabled ?? true,
  });
}

export function useCalendarEvent(
  id: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<CalendarEvent | null> {
  return useQuery({
    queryKey: qk.calendar.detail(id ?? ''),
    queryFn: () => getRepositories().calendar.getById(id!),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

export function useCalendarConflicts(
  query: ConflictQuery | null,
  options: { enabled?: boolean } = {},
): UseQueryResult<CalendarEvent[]> {
  return useQuery({
    queryKey: qk.calendar.conflicts(
      query?.startsAt ?? 0,
      query?.endsAt ?? 0,
      query?.excludeId ?? null,
    ),
    queryFn: () => getRepositories().calendar.findConflicts(query!),
    enabled: (options.enabled ?? true) && query !== null,
  });
}

export function useEventBuffers(
  id: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<CalendarEvent[]> {
  return useQuery({
    queryKey: qk.calendar.buffers(id ?? ''),
    queryFn: () => getRepositories().calendar.listBuffersFor(id!),
    enabled: (options.enabled ?? true) && Boolean(id),
  });
}

export function usePendingCalendarSync(limit = 100): UseQueryResult<CalendarEvent[]> {
  return useQuery({
    queryKey: qk.calendar.pending(limit),
    queryFn: () => getRepositories().calendar.listPendingSync(limit),
  });
}

/* ------------------------------------------------------------------ writes */

export function useCreateEvent(): UseMutationResult<CalendarEvent, Error, CreateEventInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEventInput) => getRepositories().calendar.createEvent(input),
    onSettled: () => invalidateKeys(client, CALENDAR_WRITE_KEYS),
  });
}

export function useCreateEventWithBuffer(): UseMutationResult<
  { event: CalendarEvent; buffer: CalendarEvent | null },
  Error,
  { input: CreateEventWithBufferInput; bufferMinutes?: number }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (args: { input: CreateEventWithBufferInput; bufferMinutes?: number }) =>
      getRepositories().calendar.createEventWithBuffer(args.input, {
        bufferMinutes: args.bufferMinutes,
      }),
    onSettled: () => invalidateKeys(client, CALENDAR_WRITE_KEYS),
  });
}

export function useUpdateEvent(): UseMutationResult<
  CalendarEvent,
  Error,
  { id: string; patch: UpdateEventPatch }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: UpdateEventPatch }) =>
      unwrap(await getRepositories().calendar.updateEvent(input.id, input.patch)),
    onSettled: () => invalidateKeys(client, CALENDAR_WRITE_KEYS),
  });
}

/** Keeps a tombstone so the worker can retract the event remotely. */
export function useDeleteEvent(): UseMutationResult<
  CalendarEvent,
  Error,
  { id: string; hard?: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; hard?: boolean }) => {
      const calendar = getRepositories().calendar;
      return unwrap(
        await (input.hard ? calendar.hardDelete(input.id) : calendar.softDelete(input.id)),
      );
    },
    onSettled: () => invalidateKeys(client, CALENDAR_WRITE_KEYS),
  });
}

export function useMarkEventSynced(): UseMutationResult<
  CalendarEvent,
  Error,
  { id: string; target: SyncTarget }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; target: SyncTarget }) =>
      unwrap(await getRepositories().calendar.markSynced(input.id, input.target)),
    onSettled: () => invalidateKeys(client, CALENDAR_WRITE_KEYS),
  });
}

export function useMarkEventSyncFailed(): UseMutationResult<
  CalendarEvent,
  Error,
  { id: string; error: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; error: string }) =>
      unwrap(await getRepositories().calendar.markSyncFailed(input.id, input.error)),
    onSettled: () => invalidateKeys(client, CALENDAR_WRITE_KEYS),
  });
}

export function useResolveEvent(): UseMutationResult<CalendarEvent, Error, ResolveEventQuery> {
  return useMutation({
    mutationFn: async (input: ResolveEventQuery) =>
      unwrap(await getRepositories().calendar.resolveEvent(input)),
  });
}

/** "That clashes — 4 PM instead?" Read-only, but driven by a form, so imperative. */
export function useSuggestAlternativeSlot(): UseMutationResult<
  TimeSlot | null,
  Error,
  {
    startsAt: number;
    endsAt: number;
    searchWindowHours?: number;
    excludeId?: string;
    gapMinutes?: number;
  }
> {
  return useMutation({
    mutationFn: (input: {
      startsAt: number;
      endsAt: number;
      searchWindowHours?: number;
      excludeId?: string;
      gapMinutes?: number;
    }) => getRepositories().calendar.suggestAlternativeSlot(input),
  });
}

/* ------------------------------------------------------------------- outbox */

export type SyncCounts = { pending: number; inFlight: number; failed: number };

export function useSyncCounts(): UseQueryResult<SyncCounts> {
  return useQuery({
    queryKey: qk.sync.counts(),
    queryFn: () => getRepositories().syncQueue.counts(),
  });
}

export function useSyncEntries(status: SyncStatus, limit = 100): UseQueryResult<SyncQueueEntry[]> {
  return useQuery({
    queryKey: qk.sync.byStatus(status, limit),
    queryFn: () => getRepositories().syncQueue.listByStatus(status, limit),
  });
}

export function useSyncEntriesForEntity(
  entityId: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<SyncQueueEntry[]> {
  return useQuery({
    queryKey: qk.sync.forEntity(entityId ?? ''),
    queryFn: () => getRepositories().syncQueue.listForEntity(entityId!),
    enabled: (options.enabled ?? true) && Boolean(entityId),
  });
}

export function useRetryFailedSync(): UseMutationResult<number, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => getRepositories().syncQueue.retryFailed(),
    onSettled: () => invalidateKeys(client, [qk.sync.all, qk.today.all]),
  });
}
