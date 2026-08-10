/**
 * Local calendar mirror.
 *
 * Every write lands here first and is marked `pending`; the Google/native
 * bridges read `listPendingSync()` and push afterwards. That ordering is what
 * makes the app usable offline — the UI never waits on a network round trip.
 */
import { and, asc, eq, gt, gte, isNull, lt, ne, or } from 'drizzle-orm';

import { now } from '@/core/clock';
import { rank, type Candidate } from '@/core/match';
import { AppError, fail, ok, type Result } from '@/core/result';
import { addMinutes, currentZone, dayRange, type LocalDate } from '@/core/time';
import { newId } from '@/db/ids';
import type { RidikDatabase } from '@/db/migrator';
import { calendarEvents, type CalendarEvent, type NewCalendarEvent } from '@/db/schema';

import { serialised, transactional } from './transaction';

export type CalendarEventKind = CalendarEvent['kind'];
export type CalendarSyncStatus = CalendarEvent['syncStatus'];

export type CreateEventInput = {
  title: string;
  startsAt: number;
  endsAt: number;
  description?: string | null;
  location?: string | null;
  allDay?: boolean;
  /** IANA zone the user was in when the event was spoken; defaults to the current one. */
  timezone?: string;
  kind?: CalendarEventKind;
  projectId?: string | null;
  taskId?: string | null;
  syncStatus?: CalendarSyncStatus;
};

export type CreateEventWithBufferInput = CreateEventInput & {
  /** The model's explicit "travel/prep time is warranted" flag. */
  needsBuffer?: boolean;
};

export type UpdateEventPatch = Partial<Omit<CreateEventInput, 'syncStatus'>>;

export type ResolveEventQuery = {
  query: string;
  /** Restricts the search to a single local day. */
  onDate?: LocalDate;
  /** Epoch ms the user hinted at ("...to 3 PM"); pulls the winner towards it. */
  nearTime?: number;
  zone?: string;
};

export type ConflictQuery = {
  startsAt: number;
  endsAt: number;
  excludeId?: string;
  windowMinutes?: number;
};

export type TimeSlot = { startsAt: number; endsAt: number };

export type SyncTarget = {
  googleEventId?: string | null;
  googleCalendarId?: string | null;
  nativeEventId?: string | null;
};

/** Spec 5.2: anything starting within half an hour of the new event is a clash. */
export const CONFLICT_WINDOW_MINUTES = 30;
/** Spec 2.1.3. */
export const DEFAULT_BUFFER_MINUTES = 20;
/** A buffer shorter than this is noise on the calendar, so it is dropped. */
export const MIN_BUFFER_MINUTES = 5;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Mirrors `DEFAULTS.decisiveMargin` in '@/core/match'. */
const DECISIVE_MARGIN = 0.12;

/**
 * First free slot of the same length at or after `desired.startsAt`.
 *
 * Pure so the "when is he actually free?" logic can be exercised without a
 * database; `suggestAlternativeSlot` is the thin persistence wrapper.
 */
export function findFreeSlot(
  desired: TimeSlot,
  busy: readonly TimeSlot[],
  options: { searchWindowMs: number; gapMinutes?: number },
): TimeSlot | null {
  const duration = desired.endsAt - desired.startsAt;
  if (duration <= 0) {
    throw new AppError('invalid_input', 'An event needs a positive duration.');
  }
  const gap = (options.gapMinutes ?? 0) * MINUTE_MS;
  const limit = desired.startsAt + options.searchWindowMs;

  let cursor = desired.startsAt;
  const ordered = [...busy].sort((a, b) => a.startsAt - b.startsAt);
  for (const slot of ordered) {
    if (slot.endsAt + gap <= cursor) continue;
    if (slot.startsAt - gap >= cursor + duration) break;
    cursor = slot.endsAt + gap;
  }
  return cursor + duration <= limit ? { startsAt: cursor, endsAt: cursor + duration } : null;
}

/**
 * Whether an event earns a preceding travel/prep block. Exported because the
 * decision is product policy, not persistence, and is asserted directly.
 */
export function shouldAddBuffer(input: {
  kind?: CalendarEventKind;
  location?: string | null;
  needsBuffer?: boolean;
}): boolean {
  if (input.needsBuffer === true) return true;
  if (input.kind === 'exam') return true;
  return typeof input.location === 'string' && input.location.trim().length > 0;
}

export function createCalendarEventsRepository(db: RidikDatabase) {
  async function insertRow(values: NewCalendarEvent): Promise<CalendarEvent> {
    const [row] = await db.insert(calendarEvents).values(values).returning();
    if (!row) throw new AppError('unknown', 'Could not save that event.');
    return row;
  }

  function buildRow(input: CreateEventInput, at: number): NewCalendarEvent {
    if (input.endsAt < input.startsAt) {
      throw new AppError('invalid_input', 'An event cannot end before it starts.');
    }
    return {
      id: newId(),
      title: input.title.trim(),
      description: input.description ?? null,
      location: input.location ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay: input.allDay ?? false,
      timezone: input.timezone ?? currentZone(),
      kind: input.kind ?? 'event',
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      syncStatus: input.syncStatus ?? 'pending',
      createdAt: at,
      updatedAt: at,
    };
  }

  /** Overlap, plus zero-length events that fall inside the window. */
  function withinWindow(from: number, to: number) {
    return or(
      and(lt(calendarEvents.startsAt, to), gt(calendarEvents.endsAt, from)),
      and(gte(calendarEvents.startsAt, from), lt(calendarEvents.startsAt, to)),
    );
  }

  async function getById(id: string): Promise<CalendarEvent | null> {
    const [row] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id));
    return row ?? null;
  }

  async function listBetween(
    from: number,
    to: number,
    options: { includeDeleted?: boolean } = {},
  ): Promise<CalendarEvent[]> {
    const filters = [withinWindow(from, to)];
    if (!options.includeDeleted) filters.push(isNull(calendarEvents.deletedAt));
    return db
      .select()
      .from(calendarEvents)
      .where(and(...filters))
      .orderBy(asc(calendarEvents.startsAt), asc(calendarEvents.id));
  }

  async function findConflicts(query: ConflictQuery): Promise<CalendarEvent[]> {
    const window = (query.windowMinutes ?? CONFLICT_WINDOW_MINUTES) * MINUTE_MS;
    const filters = [
      isNull(calendarEvents.deletedAt),
      lt(calendarEvents.startsAt, query.endsAt + window),
      gt(calendarEvents.endsAt, query.startsAt - window),
    ];
    if (query.excludeId) {
      filters.push(ne(calendarEvents.id, query.excludeId));
      // The event's own buffer is not a clash with the event it exists for.
      filters.push(
        or(
          isNull(calendarEvents.bufferForId),
          ne(calendarEvents.bufferForId, query.excludeId),
        )!,
      );
    }
    return db
      .select()
      .from(calendarEvents)
      .where(and(...filters))
      .orderBy(asc(calendarEvents.startsAt), asc(calendarEvents.id));
  }

  async function touch(
    id: string,
    patch: Partial<NewCalendarEvent>,
  ): Promise<Result<CalendarEvent>> {
    const [row] = await db
      .update(calendarEvents)
      .set(patch)
      .where(eq(calendarEvents.id, id))
      .returning();
    return row ? ok(row) : fail('not_found', 'I could not find that event any more.');
  }

  return {
    getById,
    listBetween,
    findConflicts,

    async createEvent(input: CreateEventInput): Promise<CalendarEvent> {
      const row = buildRow(input, now());
      // Queued like every other write: a bare insert issued while a sibling
      // call holds a transaction open is discarded if that call rolls back.
      return serialised(db, () => insertRow(row));
    },

    /**
     * Creates the event and, when warranted, a buffer immediately before it.
     * Both rows land in one transaction so a crash can never leave a buffer
     * pointing at an event that was never written.
     */
    async createEventWithBuffer(
      input: CreateEventWithBufferInput,
      options: { bufferMinutes?: number } = {},
    ): Promise<{ event: CalendarEvent; buffer: CalendarEvent | null }> {
      const bufferMinutes = options.bufferMinutes ?? DEFAULT_BUFFER_MINUTES;
      const at = now();
      const eventRow = buildRow(input, at);

      return transactional(db, async () => {
        const event = await insertRow(eventRow);
        let buffer: CalendarEvent | null = null;

        const wanted = shouldAddBuffer(input) && bufferMinutes >= MIN_BUFFER_MINUTES;
        if (wanted && !event.allDay) {
          const desiredStart = addMinutes(event.startsAt, -bufferMinutes);
          const preceding = await db
            .select()
            .from(calendarEvents)
            .where(
              and(
                isNull(calendarEvents.deletedAt),
                ne(calendarEvents.id, event.id),
                gt(calendarEvents.endsAt, desiredStart),
                lt(calendarEvents.startsAt, event.startsAt),
              ),
            );
          const start = preceding.reduce((latest, row) => Math.max(latest, row.endsAt), desiredStart);

          if (event.startsAt - start >= MIN_BUFFER_MINUTES * MINUTE_MS) {
            buffer = await insertRow({
              ...buildRow(
                {
                  title: input.location ? `Leave for ${event.title}` : `Prep for ${event.title}`,
                  startsAt: start,
                  endsAt: event.startsAt,
                  location: input.location ?? null,
                  timezone: event.timezone,
                  kind: 'buffer',
                  projectId: event.projectId,
                },
                at,
              ),
              bufferForId: event.id,
            });
          }
        }

        return { event, buffer };
      });
    },

    async listForLocalDate(
      date: LocalDate,
      zone = currentZone(),
      options: { includeDeleted?: boolean } = {},
    ): Promise<CalendarEvent[]> {
      const { start, end } = dayRange(date, zone);
      return listBetween(start, end, options);
    },

    /**
     * "Change the meeting with Ivo to 3 PM" / "my math class Monday was cancelled".
     *
     * Scores titles first and location/description at a discount, then applies a
     * temporal preference of its own: `scoreCandidate`'s built-in boost is capped
     * at 0.06, deliberately too small to separate two identically-titled events,
     * yet *when* an event sits is the strongest disambiguator a calendar has.
     */
    async resolveEvent(input: ResolveEventQuery): Promise<Result<CalendarEvent>> {
      const zone = input.zone ?? currentZone();
      const at = now();

      const rows = input.onDate
        ? await (async () => {
            const { start, end } = dayRange(input.onDate!, zone);
            return listBetween(start, end);
          })()
        : await db
            .select()
            .from(calendarEvents)
            .where(isNull(calendarEvents.deletedAt))
            .orderBy(asc(calendarEvents.startsAt));

      const candidates: Candidate<CalendarEvent>[] = rows
        // Buffers are derived rows; the user always means the real appointment.
        .filter((row) => row.kind !== 'buffer')
        .map((row) => ({
          item: row,
          text: row.title,
          aux: [row.location, row.description].filter((v): v is string => Boolean(v && v.trim())),
        }));

      // Deliberately unclamped: two exact title matches both score 1.0, and
      // clamping the sum back to 1 would erase the very signal that separates
      // "the meeting with Ivo" on Monday from the one on Wednesday.
      const scored = rank(input.query, candidates)
        .map((match) => ({
          ...match,
          final: match.score + temporalBonus(match.item, at, input.nearTime),
        }))
        .sort((a, b) => b.final - a.final);

      const [first, second] = scored;
      if (!first) {
        return fail('not_found', `I could not find an event matching "${input.query}".`);
      }
      if (second && first.final - second.final < DECISIVE_MARGIN) {
        return fail('ambiguous', 'I found more than one event that could be it.', {
          details: { matches: scored.slice(0, 5).map((m) => ({ id: m.item.id, title: m.text })) },
        });
      }
      return ok(first.item);
    },

    /** Read-modify-write, so it queues: the row must not move under us. */
    async updateEvent(id: string, patch: UpdateEventPatch): Promise<Result<CalendarEvent>> {
      return serialised(db, async () => {
        const current = await getById(id);
        if (!current) return fail('not_found', 'I could not find that event any more.');

        const startsAt = patch.startsAt ?? current.startsAt;
        const endsAt = patch.endsAt ?? current.endsAt;
        if (endsAt < startsAt) {
          throw new AppError('invalid_input', 'An event cannot end before it starts.');
        }

        return touch(id, {
          ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.location !== undefined ? { location: patch.location } : {}),
          ...(patch.allDay !== undefined ? { allDay: patch.allDay } : {}),
          ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
          ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
          ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
          ...(patch.taskId !== undefined ? { taskId: patch.taskId } : {}),
          startsAt,
          endsAt,
          syncStatus: 'pending',
          syncError: null,
          updatedAt: now(),
        });
      });
    },

    /** Keeps a tombstone so the worker can retract the event remotely. */
    async softDelete(id: string): Promise<Result<CalendarEvent>> {
      const at = now();
      return transactional(db, async () => {
        const result = await touch(id, {
          deletedAt: at,
          syncStatus: 'pending',
          syncError: null,
          updatedAt: at,
        });
        if (result.ok) {
          // The FK cascade only fires on a hard delete, so orphan buffers would
          // otherwise stay visible on the day the parent was cancelled.
          await db
            .update(calendarEvents)
            .set({ deletedAt: at, syncStatus: 'pending', updatedAt: at })
            .where(and(eq(calendarEvents.bufferForId, id), isNull(calendarEvents.deletedAt)));
        }
        return result;
      });
    },

    /**
     * Removes the row entirely (the FK cascades its buffer). It is marked
     * pending first so the returned snapshot is exactly what the outbox has to
     * push, and so a failed COMMIT leaves the row queued rather than synced.
     */
    async hardDelete(id: string): Promise<Result<CalendarEvent>> {
      const at = now();
      return transactional(db, async () => {
        const marked = await touch(id, { syncStatus: 'pending', updatedAt: at });
        if (marked.ok) {
          await db.delete(calendarEvents).where(eq(calendarEvents.id, id));
        }
        return marked;
      });
    },

    async suggestAlternativeSlot(input: {
      startsAt: number;
      endsAt: number;
      searchWindowHours?: number;
      excludeId?: string;
      gapMinutes?: number;
    }): Promise<TimeSlot | null> {
      const searchWindowMs = (input.searchWindowHours ?? 8) * HOUR_MS;
      const filters = [
        isNull(calendarEvents.deletedAt),
        gt(calendarEvents.endsAt, input.startsAt),
        lt(calendarEvents.startsAt, input.startsAt + searchWindowMs),
      ];
      if (input.excludeId) filters.push(ne(calendarEvents.id, input.excludeId));

      const busy = await db
        .select({ startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt })
        .from(calendarEvents)
        .where(and(...filters))
        .orderBy(asc(calendarEvents.startsAt));

      return findFreeSlot({ startsAt: input.startsAt, endsAt: input.endsAt }, busy, {
        searchWindowMs,
        gapMinutes: input.gapMinutes,
      });
    },

    async markSynced(id: string, target: SyncTarget): Promise<Result<CalendarEvent>> {
      return serialised(db, () =>
        touch(id, {
          ...(target.googleEventId !== undefined ? { googleEventId: target.googleEventId } : {}),
          ...(target.googleCalendarId !== undefined
            ? { googleCalendarId: target.googleCalendarId }
            : {}),
          ...(target.nativeEventId !== undefined ? { nativeEventId: target.nativeEventId } : {}),
          syncStatus: 'synced',
          syncError: null,
          updatedAt: now(),
        }),
      );
    },

    async markSyncFailed(id: string, error: string): Promise<Result<CalendarEvent>> {
      return serialised(db, () =>
        touch(id, { syncStatus: 'failed', syncError: error, updatedAt: now() }),
      );
    },

    /** Includes soft-deleted rows: a cancellation still has to reach Google. */
    async listPendingSync(limit = 100): Promise<CalendarEvent[]> {
      return db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.syncStatus, 'pending'))
        .orderBy(asc(calendarEvents.updatedAt), asc(calendarEvents.id))
        .limit(limit);
    },

    async listBuffersFor(id: string): Promise<CalendarEvent[]> {
      return db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.bufferForId, id))
        .orderBy(asc(calendarEvents.startsAt));
    },
  };
}

function temporalBonus(event: CalendarEvent, at: number, nearTime?: number): number {
  if (nearTime !== undefined) {
    const hoursAway = Math.abs(event.startsAt - nearTime) / HOUR_MS;
    return 0.2 / (1 + hoursAway / 2);
  }
  return event.startsAt >= at ? 0.08 : 0;
}

export type CalendarEventsRepository = ReturnType<typeof createCalendarEventsRepository>;

/* Re-exported so callers never need to reach into the schema module. */
export type { CalendarEvent };
