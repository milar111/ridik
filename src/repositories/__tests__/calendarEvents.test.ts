import { freezeClock } from '@/core/clock';
import { localToEpoch, setZoneOverride } from '@/core/time';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import {
  createCalendarEventsRepository,
  findFreeSlot,
  shouldAddBuffer,
  type CalendarEventsRepository,
} from '@/repositories/calendarEvents';

const ZONE = 'Europe/Sofia';
const MINUTE = 60_000;
const HOUR = 3_600_000;

/** Monday 09 March 2026, 08:00 local. */
const MONDAY = '2026-03-09';
const WEDNESDAY = '2026-03-11';
const at = (local: string) => localToEpoch(local, ZONE);

describe('calendar events repository', () => {
  let t: TestDatabase;
  let repo: CalendarEventsRepository;
  let restoreClock: () => void;

  beforeEach(() => {
    setZoneOverride(ZONE);
    restoreClock = freezeClock(at(`${MONDAY}T08:00`));
    t = createTestDatabase();
    repo = createCalendarEventsRepository(t.db);
  });

  afterEach(() => {
    restoreClock();
    setZoneOverride(null);
    t.close();
  });

  describe('create / list', () => {
    it('stores UTC epoch ms plus the originating zone and queues a push', async () => {
      const event = await repo.createEvent({
        title: '  Dentist  ',
        startsAt: at(`${MONDAY}T10:00`),
        endsAt: at(`${MONDAY}T11:00`),
        location: 'Sofia',
      });

      expect(event.title).toBe('Dentist');
      expect(event.startsAt).toBe(at(`${MONDAY}T10:00`));
      expect(event.timezone).toBe(ZONE);
      expect(event.kind).toBe('event');
      expect(event.syncStatus).toBe('pending');
      expect(event.createdAt).toBe(at(`${MONDAY}T08:00`));
    });

    it('rejects an event that ends before it starts', async () => {
      await expect(
        repo.createEvent({
          title: 'Backwards',
          startsAt: at(`${MONDAY}T11:00`),
          endsAt: at(`${MONDAY}T10:00`),
        }),
      ).rejects.toThrow(/cannot end before/i);
    });

    it('orders by start and hides soft-deleted rows unless asked', async () => {
      const late = await repo.createEvent({
        title: 'Late',
        startsAt: at(`${MONDAY}T15:00`),
        endsAt: at(`${MONDAY}T16:00`),
      });
      await repo.createEvent({
        title: 'Early',
        startsAt: at(`${MONDAY}T09:00`),
        endsAt: at(`${MONDAY}T09:30`),
      });
      await repo.softDelete(late.id);

      const visible = await repo.listForLocalDate(MONDAY, ZONE);
      expect(visible.map((e) => e.title)).toEqual(['Early']);

      const all = await repo.listForLocalDate(MONDAY, ZONE, { includeDeleted: true });
      expect(all.map((e) => e.title)).toEqual(['Early', 'Late']);
    });

    it('keeps events on the correct local day', async () => {
      await repo.createEvent({
        title: 'Late night',
        startsAt: at(`${MONDAY}T23:30`),
        endsAt: at(`${MONDAY}T23:59`),
      });
      await repo.createEvent({
        title: 'Next morning',
        startsAt: at(`${WEDNESDAY}T08:00`),
        endsAt: at(`${WEDNESDAY}T09:00`),
      });

      expect((await repo.listForLocalDate(MONDAY, ZONE)).map((e) => e.title)).toEqual([
        'Late night',
      ]);
      expect((await repo.listForLocalDate(WEDNESDAY, ZONE)).map((e) => e.title)).toEqual([
        'Next morning',
      ]);
    });
  });

  describe('conflict detection', () => {
    beforeEach(async () => {
      await repo.createEvent({
        title: 'Standup',
        startsAt: at(`${MONDAY}T10:00`),
        endsAt: at(`${MONDAY}T11:00`),
      });
    });

    it('treats exactly 30 minutes of clearance as free', async () => {
      const conflicts = await repo.findConflicts({
        startsAt: at(`${MONDAY}T11:30`),
        endsAt: at(`${MONDAY}T12:00`),
      });
      expect(conflicts).toEqual([]);
    });

    it('flags 29 minutes of clearance as a conflict', async () => {
      const conflicts = await repo.findConflicts({
        startsAt: at(`${MONDAY}T11:30`) - MINUTE,
        endsAt: at(`${MONDAY}T12:00`),
      });
      expect(conflicts.map((e) => e.title)).toEqual(['Standup']);
    });

    it('applies the window on the leading edge too', async () => {
      expect(
        await repo.findConflicts({
          startsAt: at(`${MONDAY}T09:00`),
          endsAt: at(`${MONDAY}T09:30`),
        }),
      ).toEqual([]);
      expect(
        await repo.findConflicts({
          startsAt: at(`${MONDAY}T09:00`),
          endsAt: at(`${MONDAY}T09:31`),
        }),
      ).toHaveLength(1);
    });

    it('honours a custom window', async () => {
      const conflicts = await repo.findConflicts({
        startsAt: at(`${MONDAY}T12:00`),
        endsAt: at(`${MONDAY}T12:30`),
        windowMinutes: 90,
      });
      expect(conflicts).toHaveLength(1);
    });

    it('ignores the event being moved and its own buffer', async () => {
      const { event, buffer } = await repo.createEventWithBuffer({
        title: 'Exam',
        startsAt: at(`${MONDAY}T14:00`),
        endsAt: at(`${MONDAY}T15:00`),
        location: 'Hall B',
      });
      expect(buffer).not.toBeNull();

      const conflicts = await repo.findConflicts({
        startsAt: at(`${MONDAY}T14:00`),
        endsAt: at(`${MONDAY}T15:00`),
        excludeId: event.id,
      });
      expect(conflicts).toEqual([]);
    });
  });

  describe('findFreeSlot', () => {
    it('returns the requested slot when nothing is in the way', () => {
      const slot = findFreeSlot(
        { startsAt: at(`${MONDAY}T10:00`), endsAt: at(`${MONDAY}T11:00`) },
        [],
        { searchWindowMs: 8 * HOUR },
      );
      expect(slot).toEqual({
        startsAt: at(`${MONDAY}T10:00`),
        endsAt: at(`${MONDAY}T11:00`),
      });
    });

    it('skips past back-to-back events', () => {
      const slot = findFreeSlot(
        { startsAt: at(`${MONDAY}T10:00`), endsAt: at(`${MONDAY}T11:00`) },
        [
          { startsAt: at(`${MONDAY}T10:00`), endsAt: at(`${MONDAY}T11:00`) },
          { startsAt: at(`${MONDAY}T11:00`), endsAt: at(`${MONDAY}T12:30`) },
        ],
        { searchWindowMs: 8 * HOUR },
      );
      expect(slot).toEqual({
        startsAt: at(`${MONDAY}T12:30`),
        endsAt: at(`${MONDAY}T13:30`),
      });
    });

    it('uses a gap between two events when the duration fits', () => {
      const slot = findFreeSlot(
        { startsAt: at(`${MONDAY}T10:00`), endsAt: at(`${MONDAY}T10:30`) },
        [
          { startsAt: at(`${MONDAY}T09:30`), endsAt: at(`${MONDAY}T10:15`) },
          { startsAt: at(`${MONDAY}T11:00`), endsAt: at(`${MONDAY}T12:00`) },
        ],
        { searchWindowMs: 8 * HOUR },
      );
      expect(slot).toEqual({
        startsAt: at(`${MONDAY}T10:15`),
        endsAt: at(`${MONDAY}T10:45`),
      });
    });

    it('returns null when the search window is exhausted', () => {
      const slot = findFreeSlot(
        { startsAt: at(`${MONDAY}T10:00`), endsAt: at(`${MONDAY}T11:00`) },
        [{ startsAt: at(`${MONDAY}T10:00`), endsAt: at(`${MONDAY}T20:00`) }],
        { searchWindowMs: 2 * HOUR },
      );
      expect(slot).toBeNull();
    });

    it('respects a requested gap around the slot', () => {
      const slot = findFreeSlot(
        { startsAt: at(`${MONDAY}T10:00`), endsAt: at(`${MONDAY}T10:30`) },
        [{ startsAt: at(`${MONDAY}T09:30`), endsAt: at(`${MONDAY}T10:00`) }],
        { searchWindowMs: 8 * HOUR, gapMinutes: 15 },
      );
      expect(slot).toEqual({
        startsAt: at(`${MONDAY}T10:15`),
        endsAt: at(`${MONDAY}T10:45`),
      });
    });

    it('rejects a zero-length request', () => {
      expect(() =>
        findFreeSlot({ startsAt: 0, endsAt: 0 }, [], { searchWindowMs: HOUR }),
      ).toThrow(/positive duration/i);
    });
  });

  it('suggests the first free slot after the requested time', async () => {
    await repo.createEvent({
      title: 'Blocked',
      startsAt: at(`${MONDAY}T10:00`),
      endsAt: at(`${MONDAY}T11:15`),
    });

    const slot = await repo.suggestAlternativeSlot({
      startsAt: at(`${MONDAY}T10:30`),
      endsAt: at(`${MONDAY}T11:00`),
      searchWindowHours: 4,
    });
    expect(slot).toEqual({
      startsAt: at(`${MONDAY}T11:15`),
      endsAt: at(`${MONDAY}T11:45`),
    });
  });

  describe('buffers', () => {
    it('decides from the caller flag, the kind, or a location', () => {
      expect(shouldAddBuffer({ needsBuffer: true })).toBe(true);
      expect(shouldAddBuffer({ kind: 'exam' })).toBe(true);
      expect(shouldAddBuffer({ location: 'Room 4' })).toBe(true);
      expect(shouldAddBuffer({ kind: 'event' })).toBe(false);
      expect(shouldAddBuffer({ location: '   ' })).toBe(false);
      expect(shouldAddBuffer({ location: null, needsBuffer: false })).toBe(false);
    });

    it('creates a linked buffer immediately before the event', async () => {
      const { event, buffer } = await repo.createEventWithBuffer({
        title: 'Physics exam',
        startsAt: at(`${MONDAY}T12:00`),
        endsAt: at(`${MONDAY}T13:30`),
        kind: 'exam',
      });

      expect(buffer).not.toBeNull();
      expect(buffer!.kind).toBe('buffer');
      expect(buffer!.bufferForId).toBe(event.id);
      expect(buffer!.startsAt).toBe(at(`${MONDAY}T11:40`));
      expect(buffer!.endsAt).toBe(event.startsAt);
      expect(buffer!.title).toBe('Prep for Physics exam');
    });

    it('skips the buffer when nothing warrants one', async () => {
      const { buffer } = await repo.createEventWithBuffer({
        title: 'Call mum',
        startsAt: at(`${MONDAY}T12:00`),
        endsAt: at(`${MONDAY}T12:15`),
      });
      expect(buffer).toBeNull();
    });

    it('shrinks the buffer to the gap left by a preceding event', async () => {
      await repo.createEvent({
        title: 'Lecture',
        startsAt: at(`${MONDAY}T11:00`),
        endsAt: at(`${MONDAY}T11:50`),
      });

      const { buffer } = await repo.createEventWithBuffer({
        title: 'Seminar',
        startsAt: at(`${MONDAY}T12:00`),
        endsAt: at(`${MONDAY}T13:00`),
        location: 'Building C',
      });

      expect(buffer!.startsAt).toBe(at(`${MONDAY}T11:50`));
      expect(buffer!.endsAt).toBe(at(`${MONDAY}T12:00`));
      expect(buffer!.title).toBe('Leave for Seminar');
    });

    it('skips the buffer entirely when under five minutes remain', async () => {
      await repo.createEvent({
        title: 'Lecture',
        startsAt: at(`${MONDAY}T11:00`),
        endsAt: at(`${MONDAY}T11:57`),
      });

      const { buffer } = await repo.createEventWithBuffer({
        title: 'Seminar',
        startsAt: at(`${MONDAY}T12:00`),
        endsAt: at(`${MONDAY}T13:00`),
        location: 'Building C',
      });

      expect(buffer).toBeNull();
      expect(await repo.listForLocalDate(MONDAY, ZONE)).toHaveLength(2);
    });

    it('honours an explicit buffer length and drops sub-minimum requests', async () => {
      const long = await repo.createEventWithBuffer(
        {
          title: 'Airport',
          startsAt: at(`${MONDAY}T12:00`),
          endsAt: at(`${MONDAY}T13:00`),
          location: 'Terminal 2',
        },
        { bufferMinutes: 45 },
      );
      expect(long.buffer!.startsAt).toBe(at(`${MONDAY}T11:15`));

      const none = await repo.createEventWithBuffer(
        {
          title: 'Corner shop',
          startsAt: at(`${MONDAY}T16:00`),
          endsAt: at(`${MONDAY}T16:30`),
          location: 'High street',
        },
        { bufferMinutes: 0 },
      );
      expect(none.buffer).toBeNull();
    });

    it('cascades the buffer when the parent is hard deleted', async () => {
      const { event, buffer } = await repo.createEventWithBuffer({
        title: 'Exam',
        startsAt: at(`${MONDAY}T12:00`),
        endsAt: at(`${MONDAY}T13:00`),
        kind: 'exam',
      });

      const removed = await repo.hardDelete(event.id);
      expect(removed.ok).toBe(true);
      expect(await repo.getById(event.id)).toBeNull();
      expect(await repo.getById(buffer!.id)).toBeNull();
    });

    it('soft-deletes the buffer alongside the parent', async () => {
      const { event, buffer } = await repo.createEventWithBuffer({
        title: 'Exam',
        startsAt: at(`${MONDAY}T12:00`),
        endsAt: at(`${MONDAY}T13:00`),
        kind: 'exam',
      });

      await repo.softDelete(event.id);
      const stored = await repo.getById(buffer!.id);
      expect(stored?.deletedAt).toBe(at(`${MONDAY}T08:00`));
      expect(stored?.syncStatus).toBe('pending');
      expect(await repo.listForLocalDate(MONDAY, ZONE)).toEqual([]);
    });
  });

  describe('resolveEvent', () => {
    beforeEach(async () => {
      await repo.createEvent({
        title: 'Meeting with Ivo',
        startsAt: at(`${MONDAY}T10:00`),
        endsAt: at(`${MONDAY}T11:00`),
        location: 'Office',
      });
      await repo.createEvent({
        title: 'Meeting with Ivo',
        startsAt: at(`${WEDNESDAY}T15:00`),
        endsAt: at(`${WEDNESDAY}T16:00`),
        location: 'Cafe',
      });
      await repo.createEvent({
        title: 'Math class',
        startsAt: at(`${MONDAY}T13:00`),
        endsAt: at(`${MONDAY}T14:30`),
        kind: 'class',
      });
    });

    it('picks the Ivo meeting on the requested day', async () => {
      const result = await repo.resolveEvent({ query: 'the meeting with Ivo', onDate: MONDAY });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.startsAt).toBe(at(`${MONDAY}T10:00`));
    });

    it('uses nearTime to separate two identically named events', async () => {
      const result = await repo.resolveEvent({
        query: 'meeting with Ivo',
        nearTime: at(`${WEDNESDAY}T15:00`),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.startsAt).toBe(at(`${WEDNESDAY}T15:00`));
    });

    it('resolves "my math class Monday" through the day window', async () => {
      const result = await repo.resolveEvent({ query: 'my math class', onDate: MONDAY });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.title).toBe('Math class');
    });

    it('matches on location when the title does not help', async () => {
      const result = await repo.resolveEvent({ query: 'the thing at the cafe' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.location).toBe('Cafe');
    });

    it('reports ambiguity rather than guessing', async () => {
      const result = await repo.resolveEvent({ query: 'meeting with Ivo' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('ambiguous');
    });

    it('reports not found for an unknown event', async () => {
      const result = await repo.resolveEvent({ query: 'kayaking in Norway' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('not_found');
    });

    it('never resolves to a buffer block', async () => {
      await repo.createEventWithBuffer({
        title: 'Driving lesson',
        startsAt: at(`${WEDNESDAY}T09:00`),
        endsAt: at(`${WEDNESDAY}T10:00`),
        location: 'Driving school',
      });

      const result = await repo.resolveEvent({ query: 'driving lesson', onDate: WEDNESDAY });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.kind).toBe('event');
    });

    it('ignores soft-deleted events', async () => {
      const monday = await repo.resolveEvent({ query: 'meeting with Ivo', onDate: MONDAY });
      expect(monday.ok).toBe(true);
      if (!monday.ok) return;
      await repo.softDelete(monday.value.id);

      const again = await repo.resolveEvent({ query: 'meeting with Ivo', onDate: MONDAY });
      expect(again.ok).toBe(false);
    });
  });

  describe('updates and sync bookkeeping', () => {
    it('re-queues the event after an update', async () => {
      const event = await repo.createEvent({
        title: 'Meeting with Ivo',
        startsAt: at(`${MONDAY}T10:00`),
        endsAt: at(`${MONDAY}T11:00`),
      });
      await repo.markSynced(event.id, { googleEventId: 'g-1', googleCalendarId: 'cal-1' });

      const moved = await repo.updateEvent(event.id, {
        startsAt: at(`${MONDAY}T15:00`),
        endsAt: at(`${MONDAY}T16:00`),
      });
      expect(moved.ok).toBe(true);
      if (!moved.ok) return;
      expect(moved.value.startsAt).toBe(at(`${MONDAY}T15:00`));
      expect(moved.value.syncStatus).toBe('pending');
      expect(moved.value.googleEventId).toBe('g-1');
    });

    it('returns not_found for a missing id', async () => {
      const result = await repo.updateEvent('nope', { title: 'x' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('not_found');
    });

    it('records a sync failure and lists only pending rows', async () => {
      const a = await repo.createEvent({
        title: 'A',
        startsAt: at(`${MONDAY}T10:00`),
        endsAt: at(`${MONDAY}T11:00`),
      });
      const b = await repo.createEvent({
        title: 'B',
        startsAt: at(`${MONDAY}T12:00`),
        endsAt: at(`${MONDAY}T13:00`),
      });

      await repo.markSynced(a.id, { googleEventId: 'g-a', nativeEventId: 'n-a' });
      const failed = await repo.markSyncFailed(b.id, 'HTTP 503');
      expect(failed.ok).toBe(true);

      expect(await repo.listPendingSync()).toEqual([]);

      const c = await repo.createEvent({
        title: 'C',
        startsAt: at(`${MONDAY}T14:00`),
        endsAt: at(`${MONDAY}T15:00`),
      });
      expect((await repo.listPendingSync()).map((e) => e.id)).toEqual([c.id]);
    });

    it('keeps soft-deleted events in the pending queue', async () => {
      const event = await repo.createEvent({
        title: 'Cancelled thing',
        startsAt: at(`${MONDAY}T10:00`),
        endsAt: at(`${MONDAY}T11:00`),
      });
      await repo.markSynced(event.id, { googleEventId: 'g-1' });
      await repo.softDelete(event.id);

      const pending = await repo.listPendingSync();
      expect(pending.map((e) => e.id)).toEqual([event.id]);
      expect(pending[0]!.deletedAt).not.toBeNull();
    });

    it('keeps two overlapping writes whole on the one connection', async () => {
      // Both methods open a transaction and await inside it. Unqueued, the
      // second BEGIN throws and its ROLLBACK discards the first one's rows.
      const [first, second] = await Promise.all([
        repo.createEventWithBuffer({
          title: 'Exam',
          startsAt: at(`${MONDAY}T12:00`),
          endsAt: at(`${MONDAY}T13:00`),
          location: 'Hall B',
        }),
        repo.createEventWithBuffer({
          title: 'Rehearsal',
          startsAt: at(`${MONDAY}T16:00`),
          endsAt: at(`${MONDAY}T17:00`),
          location: 'Studio',
        }),
      ]);

      expect(first!.buffer).not.toBeNull();
      expect(second!.buffer).not.toBeNull();
      expect((await repo.listForLocalDate(MONDAY, ZONE)).map((e) => e.title)).toEqual([
        'Leave for Exam',
        'Exam',
        'Leave for Rehearsal',
        'Rehearsal',
      ]);
    });

    it('does not lose a plain insert when another write rolls back', async () => {
      // The unknown project trips the foreign key, so the buffered create
      // rolls back. Unqueued, that ROLLBACK also discards the plain insert
      // that happened to be sitting inside the same open transaction.
      const [buffered, bare] = await Promise.allSettled([
        repo.createEventWithBuffer({
          title: 'Doomed',
          startsAt: at(`${MONDAY}T12:00`),
          endsAt: at(`${MONDAY}T13:00`),
          location: 'Hall B',
          projectId: 'no-such-project',
        }),
        repo.createEvent({
          title: 'Bare',
          startsAt: at(`${MONDAY}T09:00`),
          endsAt: at(`${MONDAY}T09:30`),
        }),
      ]);

      expect(buffered.status).toBe('rejected');
      expect(bare.status).toBe('fulfilled');
      expect((await repo.listForLocalDate(MONDAY, ZONE)).map((e) => e.title)).toEqual(['Bare']);
    });

    it('marks a hard-deleted event pending before removing it', async () => {
      const event = await repo.createEvent({
        title: 'Gone',
        startsAt: at(`${MONDAY}T10:00`),
        endsAt: at(`${MONDAY}T11:00`),
      });
      await repo.markSynced(event.id, { googleEventId: 'g-1' });

      const removed = await repo.hardDelete(event.id);
      expect(removed.ok).toBe(true);
      if (!removed.ok) return;
      expect(removed.value.syncStatus).toBe('pending');
      expect(removed.value.googleEventId).toBe('g-1');
      expect(await repo.getById(event.id)).toBeNull();
    });
  });
});
