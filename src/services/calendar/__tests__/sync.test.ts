import { freezeClock } from '@/core/clock';
import { fail, ok } from '@/core/result';
import { localToEpoch } from '@/core/time';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import {
  createCalendarEventsRepository,
  type CalendarEvent,
  type CalendarEventsRepository,
} from '@/repositories/calendarEvents';
import {
  BACKOFF_BASE_MS,
  createSyncQueueRepository,
  type SyncQueueRepository,
} from '@/repositories/syncQueue';
import type { RemoteCalendarEvent } from '@/services/calendar/googleApi';
import {
  LAST_SYNCED_AT_KEY,
  SYNC_TOKEN_KEY,
  createCalendarSync,
  readWorkerSetting,
  writeWorkerSetting,
  type CalendarSync,
  type GoogleBridge,
  type NativeBridge,
} from '@/services/calendar/sync';

const NOW = 1_780_000_000_000;
const ZONE = 'Europe/Sofia';
const START = localToEpoch('2026-08-11T09:00', ZONE);
const END = localToEpoch('2026-08-11T10:00', ZONE);

type Mocked<T> = { [K in keyof T]: jest.Mock } & T;

function makeGoogle(): Mocked<GoogleBridge> {
  // `calendar_events.google_event_id` is unique, so the fake has to mint a new
  // id per create exactly as Google does.
  let created = 0;
  return {
    isConnected: jest.fn(async () => true),
    calendarId: jest.fn(async () => ok('cal_1')),
    createEvent: jest.fn(async (_calendarId, resource) =>
      ok({ ...resource, id: created++ === 0 ? 'g_new' : `g_new_${created}` }),
    ),
    updateEvent: jest.fn(async (_calendarId, eventId, resource) => ok({ ...resource, id: eventId })),
    deleteEvent: jest.fn(async () => ok(undefined)),
    listEvents: jest.fn(async () => ok({ events: [], nextPageToken: null, nextSyncToken: null })),
  } as Mocked<GoogleBridge>;
}

function makeNative(): Mocked<NativeBridge> {
  return {
    isAvailable: jest.fn(async () => true),
    upsertEvent: jest.fn(async (_row, nativeId) => ok(nativeId ?? 'native_1')),
    removeEvent: jest.fn(async () => ok(undefined)),
  } as Mocked<NativeBridge>;
}

function remoteEvent(patch: Partial<RemoteCalendarEvent> = {}): RemoteCalendarEvent {
  return {
    googleEventId: 'g1',
    ridikId: null,
    title: 'Dentist',
    description: null,
    location: null,
    startsAt: START,
    endsAt: END,
    allDay: false,
    timezone: ZONE,
    updatedAt: NOW,
    cancelled: false,
    ...patch,
  };
}

describe('calendar sync worker', () => {
  let t: TestDatabase;
  let calendar: CalendarEventsRepository;
  let queue: SyncQueueRepository;
  let google: Mocked<GoogleBridge>;
  let native: Mocked<NativeBridge>;
  let sync: CalendarSync;
  let online: boolean;
  let restoreClock: () => void;

  beforeEach(() => {
    restoreClock = freezeClock(NOW);
    t = createTestDatabase();
    calendar = createCalendarEventsRepository(t.db);
    queue = createSyncQueueRepository(t.db);
    google = makeGoogle();
    native = makeNative();
    online = true;

    sync = createCalendarSync({
      repositories: { calendar, syncQueue: queue, db: t.db },
      google,
      native,
      isOnline: async () => online,
      // Cancels the jitter term so the backoff is exactly the base interval.
      backoff: { random: () => 0.5 },
    });
  });

  afterEach(() => {
    restoreClock();
    t.close();
  });

  const addEvent = (patch: Partial<Parameters<CalendarEventsRepository['createEvent']>[0]> = {}) =>
    calendar.createEvent({
      title: 'Lab meeting',
      startsAt: START,
      endsAt: END,
      timezone: ZONE,
      ...patch,
    });

  async function synced(patch: Partial<CalendarEvent> = {}): Promise<CalendarEvent> {
    const row = await addEvent();
    const marked = await calendar.markSynced(row.id, {
      googleEventId: patch.googleEventId ?? 'g1',
      googleCalendarId: patch.googleCalendarId ?? 'cal_1',
      nativeEventId: patch.nativeEventId ?? 'n1',
    });
    if (!marked.ok) throw marked.error;
    return marked.value;
  }

  /* ------------------------------------------------------------ outbox -- */

  it('returns immediately when offline without burning an attempt', async () => {
    const row = await addEvent();
    await sync.enqueue(row.id, 'create');
    online = false;

    const result = await sync.processQueue();

    expect(result).toEqual({ processed: 0, succeeded: 0, failed: 0, skipped: 'offline' });
    const [entry] = await queue.listByStatus('pending');
    expect(entry?.attempts).toBe(0);
    expect(entry?.nextAttemptAt).toBe(NOW);
    expect(google.createEvent).not.toHaveBeenCalled();
  });

  it('pushes a new event to Google and the device, then records both ids', async () => {
    const row = await addEvent();
    await sync.enqueue(row.id, 'create');

    const result = await sync.processQueue();

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0, skipped: null });
    expect(google.createEvent).toHaveBeenCalledTimes(1);
    const [calendarId, resource] = google.createEvent.mock.calls[0] as [string, { start?: { dateTime?: string } }];
    expect(calendarId).toBe('cal_1');
    expect(resource.start?.dateTime).toBe('2026-08-11T09:00:00+03:00');

    const saved = await calendar.getById(row.id);
    expect(saved).toMatchObject({
      googleEventId: 'g_new',
      googleCalendarId: 'cal_1',
      nativeEventId: 'native_1',
      syncStatus: 'synced',
    });
    expect(await queue.listByStatus('done')).toHaveLength(1);
  });

  it('updates instead of creating once the event exists remotely', async () => {
    const row = await synced();
    await sync.enqueue(row.id, 'update');

    await sync.processQueue();

    expect(google.updateEvent).toHaveBeenCalledTimes(1);
    expect(google.updateEvent.mock.calls[0]?.[1]).toBe('g1');
    expect(google.createEvent).not.toHaveBeenCalled();
  });

  it('recreates an event the user deleted in Google', async () => {
    const row = await synced();
    google.updateEvent.mockResolvedValueOnce(fail('not_found', 'That event is gone.'));
    await sync.enqueue(row.id, 'update');

    const result = await sync.processQueue();

    expect(result.succeeded).toBe(1);
    expect(google.createEvent).toHaveBeenCalledTimes(1);
    expect((await calendar.getById(row.id))?.googleEventId).toBe('g_new');
  });

  it('backs the entry off and flags the row when Google is having trouble', async () => {
    const row = await addEvent();
    google.createEvent.mockResolvedValue(
      fail('upstream', 'Google Calendar is having trouble.', { retryable: true }),
    );
    await sync.enqueue(row.id, 'create');

    const result = await sync.processQueue();

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1, skipped: null });
    const [entry] = await queue.listByStatus('pending');
    expect(entry?.attempts).toBe(1);
    expect(entry?.nextAttemptAt).toBe(NOW + BACKOFF_BASE_MS);

    const saved = await calendar.getById(row.id);
    expect(saved?.syncStatus).toBe('failed');
    expect(saved?.syncError).toContain('Google Calendar is having trouble');
  });

  it('abandons the pass when Google rejects our credentials', async () => {
    const first = await addEvent();
    const second = await addEvent({ title: 'Second' });
    await sync.enqueue(first.id, 'create');
    await sync.enqueue(second.id, 'create');
    google.createEvent.mockResolvedValue(
      fail('permission_denied', 'Reconnect your Google account in Settings.'),
    );

    const result = await sync.processQueue();

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(google.createEvent).toHaveBeenCalledTimes(1);

    // The untouched entry goes back on the queue with its budget intact.
    const pending = await queue.listByStatus('pending');
    expect(pending).toHaveLength(2);
    expect(pending.map((entry) => entry.attempts).sort()).toEqual([0, 1]);
    expect(await queue.listByStatus('in_flight')).toHaveLength(0);
  });

  it('retracts a deleted event from both targets using the queued payload', async () => {
    const row = await synced();
    await sync.enqueue(row.id, 'delete');
    // The row is gone by the time the worker runs; the payload is all we have.
    await calendar.hardDelete(row.id);

    const result = await sync.processQueue();

    expect(result.succeeded).toBe(1);
    expect(google.deleteEvent).toHaveBeenCalledWith('cal_1', 'g1', undefined);
    expect(native.removeEvent).toHaveBeenCalledWith('n1');
  });

  /**
   * The executor writes its own `calendar.delete` payload and records the
   * Google ids but not the device one. Trusting the payload alone left a copy
   * of every cancelled event on the phone.
   */
  it('retracts from the device even when the payload omits the native id', async () => {
    const row = await synced();
    await queue.enqueue({
      operation: 'calendar.delete',
      entityTable: 'calendar_events',
      entityId: row.id,
      payload: { googleEventId: 'g1', googleCalendarId: 'cal_1' },
    });
    await calendar.softDelete(row.id);

    const result = await sync.processQueue();

    expect(result.succeeded).toBe(1);
    expect(google.deleteEvent).toHaveBeenCalledWith('cal_1', 'g1', undefined);
    expect(native.removeEvent).toHaveBeenCalledWith('n1');
  });

  it('stops the pass when Google rate-limits us rather than burning the batch', async () => {
    const first = await addEvent();
    const second = await addEvent({ title: 'Second' });
    await sync.enqueue(first.id, 'create');
    await sync.enqueue(second.id, 'create');
    google.createEvent.mockResolvedValue(
      fail('rate_limited', 'Google is rate-limiting us.', { retryable: true }),
    );

    const result = await sync.processQueue();

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1, skipped: null });
    expect(google.createEvent).toHaveBeenCalledTimes(1);
    const pending = await queue.listByStatus('pending');
    expect(pending.map((entry) => entry.attempts).sort()).toEqual([0, 1]);
  });

  it('retracts a soft-deleted event and clears its pending flag', async () => {
    const row = await synced();
    await calendar.softDelete(row.id);
    await sync.enqueue(row.id, 'update');

    await sync.processQueue();

    expect(google.deleteEvent).toHaveBeenCalledWith('cal_1', 'g1', undefined);
    expect(google.updateEvent).not.toHaveBeenCalled();
    expect((await calendar.getById(row.id))?.syncStatus).toBe('synced');
  });

  it('drops a push for a row that no longer exists', async () => {
    const row = await addEvent();
    await sync.enqueue(row.id, 'create');
    await calendar.hardDelete(row.id);

    const result = await sync.processQueue();

    expect(result.succeeded).toBe(1);
    expect(google.createEvent).not.toHaveBeenCalled();
    expect(await queue.listByStatus('done')).toHaveLength(1);
  });

  it('mirrors to the device alone when Google is not connected', async () => {
    google.isConnected.mockResolvedValue(false);
    const row = await addEvent();
    await sync.enqueue(row.id, 'create');

    const result = await sync.processQueue();

    expect(result.succeeded).toBe(1);
    expect(google.createEvent).not.toHaveBeenCalled();
    const saved = await calendar.getById(row.id);
    expect(saved).toMatchObject({ googleEventId: null, nativeEventId: 'native_1', syncStatus: 'synced' });
  });

  it('keeps syncing to Google when the device calendar is refused', async () => {
    native.isAvailable.mockResolvedValue(false);
    const row = await addEvent();
    await sync.enqueue(row.id, 'create');

    const result = await sync.processQueue();

    expect(result.succeeded).toBe(1);
    expect(native.upsertEvent).not.toHaveBeenCalled();
    expect((await calendar.getById(row.id))?.googleEventId).toBe('g_new');
  });

  it('does not let a failed device mirror block the Google push', async () => {
    native.upsertEvent.mockResolvedValue(fail('unknown', 'The device calendar refused that.'));
    const row = await addEvent();
    await sync.enqueue(row.id, 'create');

    const result = await sync.processQueue();

    expect(result.succeeded).toBe(1);
    expect((await calendar.getById(row.id))?.googleEventId).toBe('g_new');
  });

  it('collapses repeated edits into a single push', async () => {
    const row = await addEvent();
    await sync.enqueue(row.id, 'create');
    await sync.enqueue(row.id, 'update');
    await sync.enqueue(row.id, 'update');

    expect(await queue.listByStatus('pending')).toHaveLength(1);
    await sync.processQueue();
    expect(google.createEvent).toHaveBeenCalledTimes(1);
  });

  it('leaves outbox rows belonging to another feature alone', async () => {
    await queue.enqueue({
      operation: 'tasks.push',
      entityTable: 'tasks',
      entityId: 'task_1',
      payload: {},
    });

    const result = await sync.processQueue();

    expect(result.processed).toBe(0);
    const [entry] = await queue.listByStatus('pending');
    expect(entry?.entityTable).toBe('tasks');
    expect(entry?.attempts).toBe(0);
  });

  /* -------------------------------------------------------------- pull -- */

  it('creates a local row for a remote event without queueing it back', async () => {
    google.listEvents.mockResolvedValueOnce(
      ok({ events: [remoteEvent()], nextPageToken: null, nextSyncToken: 'tok_1' }),
    );

    const result = await sync.pullRemoteChanges();

    expect(result.ok && result.value.created).toBe(1);
    const [row] = await calendar.listBetween(START - 1, END + 1);
    expect(row).toMatchObject({
      title: 'Dentist',
      googleEventId: 'g1',
      googleCalendarId: 'cal_1',
      syncStatus: 'synced',
    });
    expect(await readWorkerSetting<string>(t.db, SYNC_TOKEN_KEY)).toBe('tok_1');
    expect(await readWorkerSetting<number>(t.db, LAST_SYNCED_AT_KEY)).toBe(NOW);
  });

  it('applies a newer remote edit to the matching local row', async () => {
    const row = await synced();
    google.listEvents.mockResolvedValueOnce(
      ok({
        events: [remoteEvent({ title: 'Moved lab meeting', updatedAt: NOW + 1000, startsAt: START + 3_600_000, endsAt: END + 3_600_000 })],
        nextPageToken: null,
        nextSyncToken: null,
      }),
    );

    const result = await sync.pullRemoteChanges();

    expect(result.ok && result.value.updated).toBe(1);
    const saved = await calendar.getById(row.id);
    expect(saved).toMatchObject({
      title: 'Moved lab meeting',
      startsAt: START + 3_600_000,
      syncStatus: 'synced',
    });
  });

  it('ignores a remote edit that is older than ours', async () => {
    const row = await synced();
    google.listEvents.mockResolvedValueOnce(
      ok({ events: [remoteEvent({ title: 'Stale', updatedAt: NOW - 1000 })], nextPageToken: null, nextSyncToken: null }),
    );

    const result = await sync.pullRemoteChanges();

    expect(result.ok && result.value.skipped).toBe(1);
    expect((await calendar.getById(row.id))?.title).toBe('Lab meeting');
  });

  it('keeps a local edit that has not reached Google yet', async () => {
    const row = await synced();
    await calendar.updateEvent(row.id, { title: 'Local wins' });
    google.listEvents.mockResolvedValueOnce(
      ok({ events: [remoteEvent({ title: 'Remote', updatedAt: NOW + 5000 })], nextPageToken: null, nextSyncToken: null }),
    );

    const result = await sync.pullRemoteChanges();

    expect(result.ok && result.value.skipped).toBe(1);
    expect((await calendar.getById(row.id))?.title).toBe('Local wins');
  });

  it('keeps a local row that still has a queued push', async () => {
    const row = await synced();
    await sync.enqueue(row.id, 'update');
    google.listEvents.mockResolvedValueOnce(
      ok({ events: [remoteEvent({ title: 'Remote', updatedAt: NOW + 5000 })], nextPageToken: null, nextSyncToken: null }),
    );

    const result = await sync.pullRemoteChanges();

    expect(result.ok && result.value.skipped).toBe(1);
    expect((await calendar.getById(row.id))?.title).toBe('Lab meeting');
  });

  it('matches a remote event by our own id when the google id was never stored', async () => {
    const row = await addEvent();
    google.listEvents.mockResolvedValueOnce(
      ok({
        events: [remoteEvent({ googleEventId: 'g_late', ridikId: row.id, title: 'Reattached', updatedAt: NOW + 1000 })],
        nextPageToken: null,
        nextSyncToken: null,
      }),
    );

    // A pending row normally wins, so clear the flag the create left behind.
    await calendar.markSynced(row.id, {});
    const result = await sync.pullRemoteChanges();

    expect(result.ok && result.value.updated).toBe(1);
    const saved = await calendar.getById(row.id);
    expect(saved).toMatchObject({ title: 'Reattached', googleEventId: 'g_late' });
    expect(await calendar.listBetween(START - 1, END + 1)).toHaveLength(1);
  });

  it('applies a remote cancellation without pushing it straight back', async () => {
    const row = await synced();
    google.listEvents.mockResolvedValueOnce(
      ok({ events: [remoteEvent({ cancelled: true })], nextPageToken: null, nextSyncToken: null }),
    );

    const result = await sync.pullRemoteChanges();

    expect(result.ok && result.value.deleted).toBe(1);
    const saved = await calendar.getById(row.id);
    expect(saved?.deletedAt).toBe(NOW);
    expect(saved?.syncStatus).toBe('synced');
  });

  it('falls back to a windowed pull when Google retires the sync token', async () => {
    await writeWorkerSetting(t.db, SYNC_TOKEN_KEY, 'stale');
    google.listEvents
      .mockResolvedValueOnce(fail('conflict', 'Google needs a full calendar refresh.'))
      .mockResolvedValueOnce(ok({ events: [remoteEvent()], nextPageToken: null, nextSyncToken: 'tok_2' }));

    const result = await sync.pullRemoteChanges();

    expect(result.ok && result.value.created).toBe(1);
    expect(google.listEvents).toHaveBeenCalledTimes(2);
    expect(google.listEvents.mock.calls[0]?.[0]).toMatchObject({ syncToken: 'stale' });
    const retry = google.listEvents.mock.calls[1]?.[0] as { syncToken?: string; timeMin?: number };
    expect(retry.syncToken).toBeUndefined();
    expect(retry.timeMin).toBeLessThan(NOW);
    expect(await readWorkerSetting<string>(t.db, SYNC_TOKEN_KEY)).toBe('tok_2');
  });

  it('walks every page of a windowed pull', async () => {
    google.listEvents
      .mockResolvedValueOnce(
        ok({ events: [remoteEvent({ googleEventId: 'g1' })], nextPageToken: 'p2', nextSyncToken: null }),
      )
      .mockResolvedValueOnce(
        ok({ events: [remoteEvent({ googleEventId: 'g2', title: 'Second' })], nextPageToken: null, nextSyncToken: 'tok_3' }),
      );

    const result = await sync.pullRemoteChanges();

    expect(result.ok && result.value.created).toBe(2);
    expect(google.listEvents.mock.calls[1]?.[0]).toMatchObject({ pageToken: 'p2' });
  });

  /**
   * The sync token means "everything up to here is applied". Storing it after
   * an abort cut the page short retires the events we skipped: an incremental
   * pull replays only what changed *after* the token, so they never come back.
   */
  it('does not bank the sync token when an abort cut the page short', async () => {
    const controller = new AbortController();
    google.listEvents.mockImplementationOnce(async () => {
      controller.abort();
      return ok({
        events: [remoteEvent({ googleEventId: 'g1' }), remoteEvent({ googleEventId: 'g2' })],
        nextPageToken: null,
        nextSyncToken: 'tok_partial',
      });
    });

    const result = await sync.pullRemoteChanges(undefined, controller.signal);

    expect(result.ok && result.value.created).toBe(0);
    expect(await readWorkerSetting<string>(t.db, SYNC_TOKEN_KEY)).toBeNull();
    expect(await readWorkerSetting<number>(t.db, LAST_SYNCED_AT_KEY)).toBeNull();
  });

  it('refuses to pull while offline and does nothing when Google is not connected', async () => {
    online = false;
    const offline = await sync.pullRemoteChanges();
    expect(offline.ok).toBe(false);
    if (!offline.ok) expect(offline.error.code).toBe('offline');

    online = true;
    google.isConnected.mockResolvedValue(false);
    const disconnected = await sync.pullRemoteChanges();
    expect(disconnected.ok && disconnected.value.created).toBe(0);
    expect(google.listEvents).not.toHaveBeenCalled();
  });

  /* ------------------------------------------------------------ status -- */

  it('reports what the badge needs', async () => {
    const first = await addEvent();
    const second = await addEvent({ title: 'Second' });
    await sync.enqueue(first.id, 'create');
    await sync.enqueue(second.id, 'create');

    expect(await sync.syncStatus()).toEqual({
      pending: 2,
      inFlight: 0,
      failed: 0,
      lastSyncedAt: null,
    });

    await sync.processQueue();

    expect(await sync.syncStatus()).toEqual({
      pending: 0,
      inFlight: 0,
      failed: 0,
      lastSyncedAt: NOW,
    });
  });

  it('pushes a single event on demand', async () => {
    const row = await addEvent();

    const result = await sync.pushEvent(row.id);

    expect(result.ok && result.value.googleEventId).toBe('g_new');
    expect(await queue.listByStatus('pending')).toHaveLength(0);
  });

  it('tells the caller to wait when a manual push happens offline', async () => {
    const row = await addEvent();
    online = false;

    const result = await sync.pushEvent(row.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('offline');
  });
});
