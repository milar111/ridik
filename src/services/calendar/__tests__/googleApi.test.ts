import { freezeClock } from '@/core/clock';
import { ok, fail, type Result } from '@/core/result';
import { localToEpoch } from '@/core/time';
import type { CalendarEvent } from '@/db/schema';
import {
  RIDIK_ID_PROPERTY,
  classifyStatus,
  createGoogleCalendarApi,
  fromGoogleEvent,
  isSyncTokenExpired,
  toGoogleEvent,
  type GoogleEventResource,
} from '@/services/calendar/googleApi';

const NOW = 1_780_000_000_000;
const ZONE = 'Europe/Sofia';

function makeRow(patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt_1',
    title: 'Lab meeting',
    description: null,
    location: null,
    startsAt: localToEpoch('2026-08-11T09:00', ZONE),
    endsAt: localToEpoch('2026-08-11T10:00', ZONE),
    allDay: false,
    timezone: ZONE,
    kind: 'event',
    bufferForId: null,
    projectId: null,
    taskId: null,
    googleEventId: null,
    googleCalendarId: null,
    nativeEventId: null,
    syncStatus: 'pending',
    syncError: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

describe('toGoogleEvent', () => {
  it('sends a timed event as an offset-bearing instant plus its zone', () => {
    const resource = toGoogleEvent(makeRow());

    expect(resource.start).toEqual({ dateTime: '2026-08-11T09:00:00+03:00', timeZone: ZONE });
    expect(resource.end).toEqual({ dateTime: '2026-08-11T10:00:00+03:00', timeZone: ZONE });
    expect(resource.summary).toBe('Lab meeting');
  });

  it('carries our row id so a pull can find the event again', () => {
    const resource = toGoogleEvent(makeRow({ id: 'evt_42' }));
    expect(resource.extendedProperties?.private?.[RIDIK_ID_PROPERTY]).toBe('evt_42');
  });

  it('omits description and location rather than sending empty strings', () => {
    const resource = toGoogleEvent(makeRow({ description: null, location: null }));
    expect(resource.description).toBeUndefined();
    expect(resource.location).toBeUndefined();
  });

  /**
   * Europe/Sofia moves to EEST at 03:00 on 2026-03-29. Two events with the same
   * wall clock on either side of it are an hour apart in UTC, and each has to
   * be sent with the offset that was in force at *its* instant.
   */
  it('renders each side of a DST boundary with its own offset', () => {
    const before = toGoogleEvent(
      makeRow({
        startsAt: localToEpoch('2026-03-28T09:00', ZONE),
        endsAt: localToEpoch('2026-03-28T10:00', ZONE),
      }),
    );
    const after = toGoogleEvent(
      makeRow({
        startsAt: localToEpoch('2026-03-29T09:00', ZONE),
        endsAt: localToEpoch('2026-03-29T10:00', ZONE),
      }),
    );

    expect(before.start?.dateTime).toBe('2026-03-28T09:00:00+02:00');
    expect(after.start?.dateTime).toBe('2026-03-29T09:00:00+03:00');
    // Same wall clock, one hour apart in absolute time.
    expect(
      localToEpoch('2026-03-29T09:00', ZONE) - localToEpoch('2026-03-28T09:00', ZONE),
    ).toBe(23 * 3_600_000);
  });

  it('sends an all-day event as dates with an exclusive end', () => {
    const resource = toGoogleEvent(
      makeRow({
        allDay: true,
        startsAt: localToEpoch('2026-08-11', ZONE),
        endsAt: localToEpoch('2026-08-12', ZONE),
      }),
    );

    expect(resource.start).toEqual({ date: '2026-08-11' });
    expect(resource.end).toEqual({ date: '2026-08-12' });
  });

  it('rounds an all-day end that stops short of midnight up to the next day', () => {
    const resource = toGoogleEvent(
      makeRow({
        allDay: true,
        startsAt: localToEpoch('2026-08-11', ZONE),
        endsAt: localToEpoch('2026-08-11T23:59', ZONE),
      }),
    );
    expect(resource.end).toEqual({ date: '2026-08-12' });
  });

  it('gives a zero-length all-day event a full day', () => {
    const at = localToEpoch('2026-08-11', ZONE);
    const resource = toGoogleEvent(makeRow({ allDay: true, startsAt: at, endsAt: at }));
    expect(resource.start).toEqual({ date: '2026-08-11' });
    expect(resource.end).toEqual({ date: '2026-08-12' });
  });

  it('keeps a multi-day all-day span intact', () => {
    const resource = toGoogleEvent(
      makeRow({
        allDay: true,
        startsAt: localToEpoch('2026-08-11', ZONE),
        endsAt: localToEpoch('2026-08-14', ZONE),
      }),
    );
    expect(resource.end).toEqual({ date: '2026-08-14' });
  });
});

describe('fromGoogleEvent', () => {
  it('reads a timed event back to the exact instant', () => {
    const remote = fromGoogleEvent({
      id: 'g1',
      summary: 'Lab meeting',
      start: { dateTime: '2026-03-29T09:00:00+03:00', timeZone: ZONE },
      end: { dateTime: '2026-03-29T10:00:00+03:00', timeZone: ZONE },
      updated: '2026-03-28T12:00:00.000Z',
    });

    expect(remote).not.toBeNull();
    expect(remote!.startsAt).toBe(localToEpoch('2026-03-29T09:00', ZONE));
    expect(remote!.endsAt).toBe(localToEpoch('2026-03-29T10:00', ZONE));
    expect(remote!.timezone).toBe(ZONE);
    expect(remote!.allDay).toBe(false);
    expect(remote!.updatedAt).toBe(Date.parse('2026-03-28T12:00:00.000Z'));
  });

  it('reads an all-day event as local midnight boundaries', () => {
    const remote = fromGoogleEvent(
      { id: 'g2', summary: 'Conference', start: { date: '2026-08-11' }, end: { date: '2026-08-14' } },
      { defaultZone: ZONE },
    );

    expect(remote!.allDay).toBe(true);
    expect(remote!.startsAt).toBe(localToEpoch('2026-08-11', ZONE));
    expect(remote!.endsAt).toBe(localToEpoch('2026-08-14', ZONE));
    expect(remote!.timezone).toBe(ZONE);
  });

  it('gives an all-day event with no end a single day', () => {
    const remote = fromGoogleEvent(
      { id: 'g3', start: { date: '2026-08-11' } },
      { defaultZone: ZONE },
    );
    expect(remote!.endsAt - remote!.startsAt).toBe(86_400_000);
  });

  /**
   * Europe/Sofia's 2026-03-29 is 23 hours long. Ending that day at
   * `start + 24h` puts the event an hour into 2026-03-30, which renders as a
   * two-day banner and pushes the conflict window a day out.
   */
  it('ends a short DST day at the next local midnight, not 24 hours later', () => {
    const remote = fromGoogleEvent(
      { id: 'g3b', start: { date: '2026-03-29' } },
      { defaultZone: ZONE },
    );

    expect(remote!.startsAt).toBe(localToEpoch('2026-03-29', ZONE));
    expect(remote!.endsAt).toBe(localToEpoch('2026-03-30', ZONE));
    expect(remote!.endsAt - remote!.startsAt).toBe(23 * 3_600_000);
  });

  it('keeps a cancelled stub so the deletion can be applied', () => {
    const remote = fromGoogleEvent({ id: 'g4', status: 'cancelled' }, { defaultZone: ZONE });
    expect(remote).not.toBeNull();
    expect(remote!.cancelled).toBe(true);
    expect(remote!.googleEventId).toBe('g4');
  });

  it('drops resources it cannot use instead of throwing', () => {
    expect(fromGoogleEvent({ summary: 'no id' })).toBeNull();
    expect(fromGoogleEvent({ id: 'g5', summary: 'no start' })).toBeNull();
    expect(fromGoogleEvent({ id: 'g6', start: { dateTime: 'not-a-date' } })).toBeNull();
  });

  it('recovers our row id and falls back to now for a missing timestamp', () => {
    const restore = freezeClock(NOW);
    try {
      const remote = fromGoogleEvent(
        {
          id: 'g7',
          start: { dateTime: '2026-08-11T09:00:00+03:00' },
          end: { dateTime: '2026-08-11T10:00:00+03:00' },
          extendedProperties: { private: { [RIDIK_ID_PROPERTY]: 'evt_9' } },
        },
        { defaultZone: ZONE },
      );
      expect(remote!.ridikId).toBe('evt_9');
      expect(remote!.updatedAt).toBe(NOW);
    } finally {
      restore();
    }
  });

  it('round-trips a row through Google without moving it', () => {
    const row = makeRow({
      description: 'Weekly',
      location: 'Room 4',
      startsAt: localToEpoch('2026-03-29T02:30', ZONE),
      endsAt: localToEpoch('2026-03-29T04:30', ZONE),
    });
    const remote = fromGoogleEvent({ ...toGoogleEvent(row), id: 'g8' }, { defaultZone: ZONE })!;

    expect(remote.startsAt).toBe(row.startsAt);
    expect(remote.endsAt).toBe(row.endsAt);
    expect(remote.description).toBe('Weekly');
    expect(remote.location).toBe('Room 4');
    expect(remote.ridikId).toBe(row.id);
  });

  it('round-trips an all-day row', () => {
    const row = makeRow({
      allDay: true,
      startsAt: localToEpoch('2026-08-11', ZONE),
      endsAt: localToEpoch('2026-08-12', ZONE),
    });
    const remote = fromGoogleEvent({ ...toGoogleEvent(row), id: 'g9' }, { defaultZone: ZONE })!;

    expect(remote.allDay).toBe(true);
    expect(remote.startsAt).toBe(row.startsAt);
    expect(remote.endsAt).toBe(row.endsAt);
  });
});

describe('classifyStatus', () => {
  it('maps the statuses that matter', () => {
    expect(classifyStatus(401)).toBe('unauthorized');
    expect(classifyStatus(403)).toBe('unauthorized');
    expect(classifyStatus(404)).toBe('not_found');
    expect(classifyStatus(410)).toBe('sync_token_expired');
    expect(classifyStatus(429)).toBe('rate_limited');
    expect(classifyStatus(500)).toBe('server');
    expect(classifyStatus(503)).toBe('server');
    expect(classifyStatus(400)).toBe('bad_request');
  });

  it('separates a throttling 403 from a permissions 403', () => {
    expect(classifyStatus(403, 'rateLimitExceeded')).toBe('rate_limited');
    expect(classifyStatus(403, 'userRateLimitExceeded')).toBe('rate_limited');
    expect(classifyStatus(403, 'insufficientPermissions')).toBe('unauthorized');
  });
});

describe('google calendar client', () => {
  const token = async (): Promise<Result<string>> => ok('tok_123');

  function respond(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
  }

  function errorBody(status: number, message: string, reason?: string) {
    return respond(status, {
      error: { code: status, message, errors: reason ? [{ reason }] : undefined },
    });
  }

  /** Typed so `mock.calls` keeps the url and init we want to assert on. */
  function stubFetch(handler: () => Response) {
    return jest.fn(async (_url: string, _init: RequestInit) => handler());
  }

  function client(fetchImpl: ReturnType<typeof stubFetch>) {
    return createGoogleCalendarApi({
      getAccessToken: token,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://example.test/calendar/v3',
    });
  }

  it('posts a new event with the bearer token and returns the resource', async () => {
    const fetchImpl = stubFetch(() => respond(200, { id: 'g_new' }));
    const result = await client(fetchImpl).createEvent('cal_1', { summary: 'Standup' });

    expect(result.ok && result.value.id).toBe('g_new');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://example.test/calendar/v3/calendars/cal_1/events');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok_123');
    expect(JSON.parse(init.body as string)).toEqual({ summary: 'Standup' });
  });

  it('escapes calendar and event ids into the path', async () => {
    const fetchImpl = stubFetch(() => respond(200, { id: 'g1' }));
    await client(fetchImpl).updateEvent('me@example.com', 'a/b', { summary: 'x' });

    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://example.test/calendar/v3/calendars/me%40example.com/events/a%2Fb',
    );
  });

  it('maps 401 to a permission failure that is not retried', async () => {
    const fetchImpl = stubFetch(() => errorBody(401, 'Invalid Credentials'));
    const result = await client(fetchImpl).listCalendars();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('permission_denied');
    expect(result.error.retryable).toBe(false);
  });

  it('maps a throttling 403 to a retryable rate limit', async () => {
    const fetchImpl = stubFetch(() => errorBody(403, 'Rate Limit Exceeded', 'rateLimitExceeded'));
    const result = await client(fetchImpl).listCalendars();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('rate_limited');
    expect(result.error.retryable).toBe(true);
  });

  it('maps 429 and 5xx to retryable failures', async () => {
    const limited = await client(stubFetch(() => errorBody(429, 'slow down'))).listCalendars();
    const broken = await client(stubFetch(() => errorBody(503, 'backend error'))).listCalendars();

    expect(limited.ok).toBe(false);
    expect(broken.ok).toBe(false);
    if (limited.ok || broken.ok) return;
    expect([limited.error.code, limited.error.retryable]).toEqual(['rate_limited', true]);
    expect([broken.error.code, broken.error.retryable]).toEqual(['upstream', true]);
  });

  it('maps 404 to not_found', async () => {
    const fetchImpl = stubFetch(() => errorBody(404, 'Not Found'));
    const result = await client(fetchImpl).updateEvent('cal_1', 'gone', { summary: 'x' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
    expect(result.error.retryable).toBe(false);
  });

  it('maps a dropped connection to a retryable offline failure', async () => {
    const fetchImpl = stubFetch(() => {
      throw new TypeError('Network request failed');
    });
    const result = await client(fetchImpl).listCalendars();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('offline');
    expect(result.error.retryable).toBe(true);
  });

  it('treats an already-deleted event as a successful delete', async () => {
    const fetchImpl = stubFetch(() => errorBody(404, 'Not Found'));
    const result = await client(fetchImpl).deleteEvent('cal_1', 'gone');
    expect(result.ok).toBe(true);
  });

  it('flags an expired sync token so the caller can fall back', async () => {
    const fetchImpl = stubFetch(() => errorBody(410, 'Sync token is no longer valid'));
    const result = await client(fetchImpl).listEvents({ calendarId: 'cal_1', syncToken: 'stale' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('conflict');
    expect(isSyncTokenExpired(result.error)).toBe(true);
  });

  it('never sends a time range alongside a sync token', async () => {
    const fetchImpl = stubFetch(() => respond(200, { items: [], nextSyncToken: 'next' }));
    await client(fetchImpl).listEvents({
      calendarId: 'cal_1',
      syncToken: 'tok',
      timeMin: NOW,
      timeMax: NOW + 1000,
    });

    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain('syncToken=tok');
    expect(url).not.toContain('timeMin');
    expect(url).toContain('singleEvents=true');
  });

  it('maps a page of events and hands back both tokens', async () => {
    const items: GoogleEventResource[] = [
      {
        id: 'g1',
        summary: 'Lecture',
        start: { dateTime: '2026-08-11T09:00:00+03:00', timeZone: ZONE },
        end: { dateTime: '2026-08-11T10:00:00+03:00', timeZone: ZONE },
        updated: '2026-08-10T09:00:00.000Z',
      },
      { id: 'g2', status: 'cancelled' },
      { summary: 'unusable' },
    ];
    const fetchImpl = stubFetch(() =>
      respond(200, { items, nextPageToken: 'p2', nextSyncToken: null, timeZone: ZONE }),
    );

    const result = await client(fetchImpl).listEvents({ calendarId: 'cal_1', timeMin: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.events).toHaveLength(2);
    expect(result.value.events[0]!.title).toBe('Lecture');
    expect(result.value.events[1]!.cancelled).toBe(true);
    expect(result.value.nextPageToken).toBe('p2');
    expect(result.value.nextSyncToken).toBeNull();
  });

  it('keeps only writable calendars and marks the primary one', async () => {
    const fetchImpl = stubFetch(() =>
      respond(200, {
        items: [
          { id: 'primary@example.com', summary: 'Me', primary: true, accessRole: 'owner' },
          { id: 'team', summary: 'Team', accessRole: 'writer', timeZone: ZONE },
          { summary: 'no id' },
        ],
      }),
    );

    const result = await client(fetchImpl).listCalendars();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      { id: 'primary@example.com', summary: 'Me', primary: true, accessRole: 'owner', timeZone: null },
      { id: 'team', summary: 'Team', primary: false, accessRole: 'writer', timeZone: ZONE },
    ]);
    expect(fetchImpl.mock.calls[0]![0]).toContain('minAccessRole=writer');
  });

  it('never calls out when there is no usable token', async () => {
    const fetchImpl = stubFetch(() => respond(200, {}));
    const api = createGoogleCalendarApi({
      getAccessToken: async () => fail('permission_denied', 'Connect your Google account.'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await api.listCalendars();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('permission_denied');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
