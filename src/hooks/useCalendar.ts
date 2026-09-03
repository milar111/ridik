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

import {
  CALENDAR_ENTITY_TABLE,
  SYNC_OPERATIONS,
  pushEventNow,
  type CalendarSyncPayload,
} from '@/services/calendar';

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

/* -------------------------------------------------------------- outbox -- */

/**
 * Puts one screen-made change in the sync outbox.
 *
 * This did not exist, and its absence was the whole of a bug that made the app
 * quietly wrong rather than visibly broken: **only the assistant's writes were
 * ever synced.** `src/llm/executor.ts` has done this since sync was built, so
 * an event the user *spoke* reached Google and the phone's own calendar, while
 * the identical event created, edited or deleted on the calendar screen changed
 * nothing anywhere but SQLite. Deleting was the loudest case — the event
 * vanished from Ridik and stayed in Google for ever — and `useDeleteEvent`
 * carried the comment "keeps a tombstone so the worker can retract the event
 * remotely" over code that never told the worker anything.
 *
 * It takes the **row**, not an id, and that is the point rather than a
 * convenience. `enqueueEventSync` in the service re-reads by id, which is
 * correct for a soft delete and silently useless for a hard one: the row is
 * already gone, so all three remote ids come back null and the retraction has
 * nothing left to retract. The ids have to be copied off the row the mutation
 * returned, while it still exists.
 *
 * Queue first, then try to land it now. The queue is the durable path and the
 * push is an optimisation; doing it the other way round means a change that
 * succeeds immediately is never recorded, and one that fails is lost.
 */
async function queueSync(event: CalendarEvent, operation: 'push' | 'delete'): Promise<void> {
  try {
    await getRepositories().syncQueue.enqueue({
      operation: operation === 'delete' ? SYNC_OPERATIONS.delete : SYNC_OPERATIONS.push,
      entityTable: CALENDAR_ENTITY_TABLE,
      entityId: event.id,
      payload: {
        googleEventId: event.googleEventId,
        googleCalendarId: event.googleCalendarId,
        nativeEventId: event.nativeEventId,
      } satisfies CalendarSyncPayload,
    });
    await pushEventNow(event.id);
  } catch {
    // Never the user's problem, and never the mutation's. The row is written;
    // syncing it is the queue's job and the queue is durable, so a failure here
    // is a retry later rather than a screen that says the save did not work.
  }
}

/* ------------------------------------------------------------------ writes */

export function useCreateEvent(): UseMutationResult<CalendarEvent, Error, CreateEventInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateEventInput) => {
      const event = await getRepositories().calendar.createEvent(input);
      await queueSync(event, 'push');
      return event;
    },
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
    mutationFn: async (args: { input: CreateEventWithBufferInput; bufferMinutes?: number }) => {
      const created = await getRepositories().calendar.createEventWithBuffer(args.input, {
        bufferMinutes: args.bufferMinutes,
      });
      // The travel block is a real event with its own remote copy, so it syncs
      // on its own account — the executor does the same for the pair.
      await queueSync(created.event, 'push');
      if (created.buffer) await queueSync(created.buffer, 'push');
      return created;
    },
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
    mutationFn: async (input: { id: string; patch: UpdateEventPatch }) => {
      const updated = unwrap(await getRepositories().calendar.updateEvent(input.id, input.patch));
      await queueSync(updated, 'push');
      return updated;
    },
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
      // Any travel block hanging off this event goes with it, and has to be
      // read *before* the delete — a hard delete takes the rows with it and a
      // soft one hides them from this query.
      const buffers = (await calendar.listBuffersFor(input.id)).filter(
        (row) => row.deletedAt === null,
      );
      const removed = unwrap(
        await (input.hard ? calendar.hardDelete(input.id) : calendar.softDelete(input.id)),
      );
      await queueSync(removed, 'delete');
      for (const buffer of buffers) await queueSync(buffer, 'delete');
      return removed;
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
