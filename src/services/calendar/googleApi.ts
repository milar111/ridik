/**
 * Google Calendar over plain REST.
 *
 * No SDK: googleapis assumes Node and pulls a small universe of polyfills into
 * the bundle for what is, in the end, five endpoints.
 *
 * The mapping layer is the interesting part. Our rows store an instant (UTC
 * epoch ms) plus the IANA zone the user was in; Google stores a wall clock plus
 * a zone. Round-tripping through an offset alone is not enough — an event moved
 * across a DST boundary has to keep the wall clock the user asked for — so every
 * conversion goes through the event's own `timezone` and `timeZone` travels with
 * the resource.
 */
import { now } from '@/core/clock';
import type { Logger } from '@/core/logger';
import { AppError, err, fail, ok, type AppErrorCode, type Result } from '@/core/result';
import { DateTime, anyToEpoch, currentZone } from '@/core/time';
import type { CalendarEvent } from '@/db/schema';

export const GOOGLE_CALENDAR_BASE_URL = 'https://www.googleapis.com/calendar/v3';
/** Google's alias for the signed-in user's own calendar. */
export const PRIMARY_CALENDAR_ID = 'primary';
/**
 * Our row id, round-tripped through the resource. It survives an event being
 * edited in Google's own UI, which is what lets a pull re-attach a remote event
 * to the local row that spawned it even if `google_event_id` was never stored.
 */
export const RIDIK_ID_PROPERTY = 'ridikId';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_PAGE_SIZE = 250;

/* --------------------------------------------------------------- resources -- */

export type GoogleEventTime = {
  /** All-day events only: `YYYY-MM-DD`. The end date is *exclusive*. */
  date?: string;
  /** Timed events only: RFC3339 with an offset. */
  dateTime?: string;
  timeZone?: string;
};

export type GoogleEventResource = {
  id?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled' | (string & {});
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  /** RFC3339, set by Google on every write. */
  updated?: string;
  htmlLink?: string;
  extendedProperties?: { private?: Record<string, string> };
};

export type GoogleCalendarSummary = {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
  timeZone: string | null;
};

/** A remote event flattened into the shape our repository speaks. */
export type RemoteCalendarEvent = {
  googleEventId: string;
  /** Set when the event originated here. */
  ridikId: string | null;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  timezone: string;
  updatedAt: number;
  /** Google keeps cancelled events in incremental results so we can delete ours. */
  cancelled: boolean;
};

/* ----------------------------------------------------------------- mappers -- */

/**
 * Local row to Google resource.
 *
 * Timed events are sent as an offset-bearing RFC3339 instant *and* the zone
 * name: the instant pins the moment, the zone tells Google which wall clock to
 * render and how to move the event when the user edits it after a DST change.
 */
export function toGoogleEvent(row: CalendarEvent): GoogleEventResource {
  const zone = row.timezone || currentZone();
  const resource: GoogleEventResource = {
    summary: row.title,
    ...(row.description ? { description: row.description } : {}),
    ...(row.location ? { location: row.location } : {}),
    ...(row.allDay ? allDayRange(row, zone) : timedRange(row, zone)),
    extendedProperties: { private: { [RIDIK_ID_PROPERTY]: row.id } },
  };
  return resource;
}

function timedRange(row: CalendarEvent, zone: string): Pick<GoogleEventResource, 'start' | 'end'> {
  return {
    start: { dateTime: rfc3339(row.startsAt, zone), timeZone: zone },
    end: { dateTime: rfc3339(Math.max(row.endsAt, row.startsAt), zone), timeZone: zone },
  };
}

/**
 * All-day events carry `date`, never `dateTime`, and Google's end date is the
 * first day *not* covered. Our rows store the end as an instant, which for a
 * one-day event is the following midnight — already exclusive — but a row whose
 * end was rounded to 23:59 (or left equal to the start) has to be pushed out to
 * the next day or Google rejects the resource.
 */
function allDayRange(row: CalendarEvent, zone: string): Pick<GoogleEventResource, 'start' | 'end'> {
  const startDay = DateTime.fromMillis(row.startsAt, { zone }).startOf('day');
  const endInstant = DateTime.fromMillis(row.endsAt, { zone });
  const boundary = endInstant.equals(endInstant.startOf('day'))
    ? endInstant
    : endInstant.startOf('day').plus({ days: 1 });
  const endDay = boundary > startDay ? boundary : startDay.plus({ days: 1 });
  return {
    start: { date: startDay.toISODate()! },
    end: { date: endDay.toISODate()! },
  };
}

function rfc3339(epoch: number, zone: string): string {
  return DateTime.fromMillis(epoch, { zone }).toISO({ suppressMilliseconds: true })!;
}

/**
 * Google resource to our shape. Returns null for anything unusable — a resource
 * with no id, or a live event with no start — because one malformed row in a
 * page must not abort the whole pull.
 *
 * A cancelled event is kept even when it carries nothing but an id: incremental
 * results deliver deletions that way, and the id is all the caller needs.
 */
export function fromGoogleEvent(
  resource: GoogleEventResource,
  options: { defaultZone?: string; now?: number } = {},
): RemoteCalendarEvent | null {
  const googleEventId = resource.id;
  if (!googleEventId) return null;

  const cancelled = resource.status === 'cancelled';
  const zone =
    resource.start?.timeZone ?? resource.end?.timeZone ?? options.defaultZone ?? currentZone();
  const range = readRange(resource, zone);
  if (!range && !cancelled) return null;

  return {
    googleEventId,
    ridikId: resource.extendedProperties?.private?.[RIDIK_ID_PROPERTY] ?? null,
    title: resource.summary?.trim() || 'Untitled',
    description: resource.description ?? null,
    location: resource.location ?? null,
    startsAt: range?.startsAt ?? 0,
    endsAt: range?.endsAt ?? 0,
    allDay: range?.allDay ?? false,
    timezone: zone,
    updatedAt: parseEpoch(resource.updated) ?? options.now ?? now(),
    cancelled,
  };
}

function readRange(
  resource: GoogleEventResource,
  zone: string,
): { startsAt: number; endsAt: number; allDay: boolean } | null {
  const { start, end } = resource;
  if (start?.date) {
    const startsAt = parseLocalDate(start.date, zone);
    if (startsAt === null) return null;
    const endsAt = (end?.date && parseLocalDate(end.date, zone)) || null;
    return {
      startsAt,
      // Missing or degenerate end: an all-day event covers at least its own day.
      // "Its own day" is the next local midnight, not `+ 24h` — the day the
      // clocks change is 23 or 25 hours long and a fixed offset lands the end
      // inside the following day.
      endsAt: endsAt !== null && endsAt > startsAt ? endsAt : nextMidnight(startsAt, zone),
      allDay: true,
    };
  }
  if (start?.dateTime) {
    const startsAt = parseEpoch(start.dateTime, zone);
    if (startsAt === null) return null;
    const endsAt = parseEpoch(end?.dateTime, zone);
    return { startsAt, endsAt: endsAt !== null && endsAt >= startsAt ? endsAt : startsAt, allDay: false };
  }
  return null;
}

function parseLocalDate(date: string, zone: string): number | null {
  const dt = DateTime.fromISO(date, { zone });
  return dt.isValid ? dt.startOf('day').toMillis() : null;
}

function nextMidnight(epoch: number, zone: string): number {
  return DateTime.fromMillis(epoch, { zone }).plus({ days: 1 }).startOf('day').toMillis();
}

function parseEpoch(value: string | undefined, zone?: string): number | null {
  if (!value) return null;
  try {
    return anyToEpoch(value, zone);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ errors -- */

export type GoogleApiErrorCode =
  | 'unauthorized'
  | 'rate_limited'
  | 'server'
  | 'not_found'
  | 'sync_token_expired'
  | 'offline'
  | 'bad_request'
  | 'unknown';

const ERROR_MAPPING: Record<
  GoogleApiErrorCode,
  { code: AppErrorCode; retryable: boolean; message: string }
> = {
  unauthorized: {
    code: 'permission_denied',
    retryable: false,
    message: 'Google rejected our access. Reconnect your Google account in Settings.',
  },
  rate_limited: {
    code: 'rate_limited',
    retryable: true,
    message: 'Google is rate-limiting us. I will retry shortly.',
  },
  server: {
    code: 'upstream',
    retryable: true,
    message: 'Google Calendar is having trouble. I will retry shortly.',
  },
  not_found: { code: 'not_found', retryable: false, message: 'That event is no longer in Google Calendar.' },
  sync_token_expired: {
    code: 'conflict',
    retryable: false,
    message: 'Google needs a full calendar refresh.',
  },
  offline: {
    code: 'offline',
    retryable: true,
    message: "I couldn't reach Google Calendar. Check your connection.",
  },
  bad_request: {
    code: 'invalid_input',
    retryable: false,
    message: 'Google refused that change.',
  },
  unknown: {
    code: 'upstream',
    retryable: true,
    message: 'Google Calendar is having trouble. I will retry shortly.',
  },
};

/**
 * HTTP status to our vocabulary.
 *
 * 403 is overloaded at Google: it is both "you may not touch this calendar" and
 * "you are going too fast". Only the error `reason` separates them, and getting
 * it wrong means either burning the retry budget on a permanent failure or
 * dropping a request that would have succeeded a second later.
 */
export function classifyStatus(status: number, reason?: string): GoogleApiErrorCode {
  if (status === 403 && reason && /rateLimit|userRateLimit|quotaExceeded/i.test(reason)) {
    return 'rate_limited';
  }
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  // Only the events feed uses 410, and only to retire an expired sync token.
  if (status === 410) return 'sync_token_expired';
  if (status === 429) return 'rate_limited';
  if (status === 408) return 'offline';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

export function googleApiError(
  code: GoogleApiErrorCode,
  options: { status?: number; detail?: string; cause?: unknown } = {},
): AppError {
  const mapped = ERROR_MAPPING[code];
  return new AppError(mapped.code, mapped.message, {
    retryable: mapped.retryable,
    cause: options.cause,
    details: { googleCode: code, status: options.status, detail: options.detail },
  });
}

export function isSyncTokenExpired(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.details as { googleCode?: string } | undefined)?.googleCode === 'sync_token_expired'
  );
}

/** Google's error envelope; the body is best-effort, never trusted. */
function readErrorBody(body: string): { message?: string; reason?: string } {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; errors?: { reason?: string }[]; status?: string };
    };
    return {
      message: parsed.error?.message,
      reason: parsed.error?.errors?.[0]?.reason ?? parsed.error?.status,
    };
  } catch {
    return { message: body.slice(0, 200) };
  }
}

/* ------------------------------------------------------------------ client -- */

export type GoogleApiOptions = {
  /** Async so the caller can refresh an expiring token before every call. */
  getAccessToken: () => Promise<Result<string>>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** 0 disables the client-side timeout. */
  timeoutMs?: number;
  logger?: Pick<Logger, 'warn' | 'error'>;
};

export type ListEventsQuery = {
  calendarId?: string;
  timeMin?: number;
  timeMax?: number;
  /** Incremental cursor from a previous page. Mutually exclusive with the range. */
  syncToken?: string;
  pageToken?: string;
  maxResults?: number;
  showDeleted?: boolean;
};

export type ListEventsPage = {
  events: RemoteCalendarEvent[];
  nextPageToken: string | null;
  /** Present on the last page only; store it to make the next pull incremental. */
  nextSyncToken: string | null;
};

type CallInput = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  /** Statuses that are not failures for this particular call. */
  tolerate?: readonly number[];
};

export function createGoogleCalendarApi(options: GoogleApiOptions) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? GOOGLE_CALENDAR_BASE_URL).replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = options.logger;

  async function call<T>(input: CallInput): Promise<Result<T | null>> {
    const token = await options.getAccessToken();
    if (!token.ok) return token;

    const url = `${baseUrl}${input.path}${encodeQuery(input.query)}`;
    const link = linkSignals(input.signal, timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${token.value}`,
          ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        ...(link.signal ? { signal: link.signal } : {}),
      });
    } catch (error) {
      // A caller-driven abort is not a network problem and must not be retried.
      if (input.signal?.aborted) {
        return fail('unknown', 'That sync was cancelled.', { retryable: false, cause: error });
      }
      return err(googleApiError('offline', { cause: error }));
    } finally {
      link.done();
    }

    if (input.tolerate?.includes(response.status)) return ok(null);

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      const { message, reason } = readErrorBody(raw);
      const code = classifyStatus(response.status, reason);
      logger?.warn('google calendar call failed', {
        status: response.status,
        code,
        reason,
        path: input.path,
      });
      return err(googleApiError(code, { status: response.status, detail: message }));
    }

    if (response.status === 204) return ok(null);
    const text = await response.text().catch(() => '');
    if (!text) return ok(null);
    try {
      return ok(JSON.parse(text) as T);
    } catch (error) {
      logger?.error('google calendar returned unparseable JSON', { path: input.path });
      return err(googleApiError('unknown', { status: response.status, cause: error }));
    }
  }

  async function listCalendars(signal?: AbortSignal): Promise<Result<GoogleCalendarSummary[]>> {
    const result = await call<{
      items?: { id?: string; summary?: string; primary?: boolean; accessRole?: string; timeZone?: string }[];
    }>({ method: 'GET', path: '/users/me/calendarList', query: { minAccessRole: 'writer' }, signal });
    if (!result.ok) return result;

    const items = result.value?.items ?? [];
    return ok(
      items
        .filter((item): item is { id: string } & typeof item => Boolean(item.id))
        .map((item) => ({
          id: item.id,
          summary: item.summary ?? item.id,
          primary: item.primary === true,
          accessRole: item.accessRole ?? 'reader',
          timeZone: item.timeZone ?? null,
        })),
    );
  }

  async function createEvent(
    calendarId: string,
    event: GoogleEventResource,
    signal?: AbortSignal,
  ): Promise<Result<GoogleEventResource>> {
    const result = await call<GoogleEventResource>({
      method: 'POST',
      path: `/calendars/${encodeURIComponent(calendarId)}/events`,
      body: event,
      signal,
    });
    if (!result.ok) return result;
    return result.value?.id
      ? ok(result.value)
      : err(googleApiError('unknown', { detail: 'Google created an event with no id.' }));
  }

  async function updateEvent(
    calendarId: string,
    eventId: string,
    event: GoogleEventResource,
    signal?: AbortSignal,
  ): Promise<Result<GoogleEventResource>> {
    // PUT, not PATCH: our row is the whole truth for the fields we own, so a
    // description the user cleared locally has to disappear remotely too.
    const result = await call<GoogleEventResource>({
      method: 'PUT',
      path: `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      body: event,
      signal,
    });
    if (!result.ok) return result;
    return ok(result.value ?? { ...event, id: eventId });
  }

  async function deleteEvent(
    calendarId: string,
    eventId: string,
    signal?: AbortSignal,
  ): Promise<Result<void>> {
    // Already gone is the outcome we wanted; retrying it would never succeed.
    const result = await call<null>({
      method: 'DELETE',
      path: `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      tolerate: [404, 410],
      signal,
    });
    return result.ok ? ok(undefined) : result;
  }

  async function listEvents(
    query: ListEventsQuery = {},
    signal?: AbortSignal,
  ): Promise<Result<ListEventsPage>> {
    const calendarId = query.calendarId ?? PRIMARY_CALENDAR_ID;
    // Google rejects a request carrying both a sync token and a time range.
    const range = query.syncToken
      ? {}
      : {
          timeMin: query.timeMin === undefined ? undefined : new Date(query.timeMin).toISOString(),
          timeMax: query.timeMax === undefined ? undefined : new Date(query.timeMax).toISOString(),
        };

    const result = await call<{
      items?: GoogleEventResource[];
      nextPageToken?: string;
      nextSyncToken?: string;
      timeZone?: string;
    }>({
      method: 'GET',
      path: `/calendars/${encodeURIComponent(calendarId)}/events`,
      query: {
        ...range,
        syncToken: query.syncToken,
        pageToken: query.pageToken,
        maxResults: query.maxResults ?? DEFAULT_PAGE_SIZE,
        // Recurrences are expanded into instances: the app has no recurrence
        // model, and a user editing "Friday's lecture" means that instance.
        singleEvents: true,
        showDeleted: query.showDeleted ?? true,
      },
      signal,
    });
    if (!result.ok) return result;

    const defaultZone = result.value?.timeZone ?? currentZone();
    const events = (result.value?.items ?? [])
      .map((item) => fromGoogleEvent(item, { defaultZone }))
      .filter((item): item is RemoteCalendarEvent => item !== null);

    return ok({
      events,
      nextPageToken: result.value?.nextPageToken ?? null,
      nextSyncToken: result.value?.nextSyncToken ?? null,
    });
  }

  return { listCalendars, createEvent, updateEvent, deleteEvent, listEvents };
}

export type GoogleCalendarApi = ReturnType<typeof createGoogleCalendarApi>;

function encodeQuery(query: CallInput['query']): string {
  if (!query) return '';
  const parts = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/** One signal that trips on either the caller's abort or our own timeout. */
function linkSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; done: () => void } {
  if (timeoutMs <= 0) return { signal: external, done: () => {} };

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener('abort', onAbort);

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}
