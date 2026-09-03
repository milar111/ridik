/**
 * The calendar facade.
 *
 * Screens and the LLM executor talk to this and nothing else: connect,
 * disconnect, sync, ask how it is going, and queue one event for syncing. The
 * OAuth dance, the REST client, the device mirror and the outbox worker are all
 * assembled here so no caller has to know they exist.
 */
import { createLogger } from '@/core/logger';
import { fail, ok, type Result } from '@/core/result';
import { getRepositories } from '@/repositories';

import { createGoogleCalendarApi, PRIMARY_CALENDAR_ID, type GoogleCalendarApi } from './googleApi';
import {
  getAccessToken,
  getAccountEmail,
  isConfigured,
  isSignedIn,
  signIn,
  signOut,
} from './googleAuth';
import {
  ensurePermission as ensureNativePermission,
  getOrCreateRidikCalendar,
  hasPermission as hasNativePermission,
  removeEvent as removeNativeEvent,
  upsertEvent as upsertNativeEvent,
} from './nativeCalendar';
import {
  createCalendarSync,
  type CalendarSync,
  type CalendarSyncOperation,
  type ProcessQueueResult,
  type PullSummary,
  type SyncStatusSnapshot,
} from './sync';

const log = createLogger('calendar');

export type ConnectionSnapshot = {
  configured: boolean;
  connected: boolean;
  email: string | null;
  calendarId: string | null;
  nativeMirror: boolean;
};

export type SyncRunSummary = {
  queue: ProcessQueueResult;
  /** Null when the pull was skipped (offline, or Google not connected). */
  pull: PullSummary | null;
};

let api: GoogleCalendarApi | null = null;
let sync: CalendarSync | null = null;

function getApi(): GoogleCalendarApi {
  if (!api) api = createGoogleCalendarApi({ getAccessToken, logger: log });
  return api;
}

/**
 * The Google calendar we write to. Stored once so events do not scatter across
 * calendars if the user's default changes, and defaulting to `primary` so a
 * failed lookup still writes somewhere sensible.
 */
async function resolveGoogleCalendarId(): Promise<Result<string>> {
  const settings = getRepositories().settings;
  const stored = await settings.get('googleCalendarId');
  if (stored) return ok(stored);

  const calendars = await getApi().listCalendars();
  if (!calendars.ok) return calendars;

  // Only the flagged primary, then Google's own `primary` alias. Picking
  // whichever other writable calendar happened to come back first is a guess,
  // and a wrong one scatters the user's events into a calendar they never
  // chose — the alias always resolves to the account's own calendar.
  const chosen = calendars.value.find((entry) => entry.primary) ?? null;
  const id = chosen?.id ?? PRIMARY_CALENDAR_ID;
  await settings.set('googleCalendarId', id);
  return ok(id);
}

function getSync(): CalendarSync {
  if (sync) return sync;
  const client = getApi();

  sync = createCalendarSync({
    repositories: getRepositories(),
    google: {
      isConnected: isSignedIn,
      calendarId: resolveGoogleCalendarId,
      createEvent: (calendarId, resource, signal) => client.createEvent(calendarId, resource, signal),
      updateEvent: (calendarId, eventId, resource, signal) =>
        client.updateEvent(calendarId, eventId, resource, signal),
      deleteEvent: (calendarId, eventId, signal) => client.deleteEvent(calendarId, eventId, signal),
      listEvents: (query, signal) => client.listEvents(query, signal),
    },
    native: {
      // Never `ensurePermission` here: the worker can run in the background and
      // a permission dialog fired from there is a dialog nobody is looking at.
      isAvailable: hasNativePermission,
      upsertEvent: upsertNativeEvent,
      removeEvent: removeNativeEvent,
    },
    logger: log,
  });
  return sync;
}

/** Test/logout hook — drops the memoised client and worker. */
export function resetCalendarService(): void {
  api = null;
  sync = null;
}

/**
 * Signs in to Google, picks the target calendar and prepares the device mirror.
 *
 * The device calendar is best effort: a user who says no to calendar access
 * still gets a working Google sync.
 */
export async function connect(): Promise<Result<ConnectionSnapshot>> {
  if (!isConfigured()) {
    return fail('unsupported', 'Google sign-in is not configured in this build.');
  }

  const session = await signIn();
  if (!session.ok) return session;

  const calendarId = await resolveGoogleCalendarId();
  if (!calendarId.ok) {
    log.warn('signed in but could not list calendars', calendarId.error.message);
  }

  const mirror = await ensureNativePermission();
  if (mirror.ok) {
    const created = await getOrCreateRidikCalendar();
    if (!created.ok) log.warn('device calendar unavailable', created.error.message);
  }

  resetCalendarService();
  return ok({
    configured: true,
    connected: true,
    email: session.value.email,
    calendarId: calendarId.ok ? calendarId.value : null,
    nativeMirror: mirror.ok,
  });
}

export async function disconnect(): Promise<Result<void>> {
  const result = await signOut();
  resetCalendarService();
  return result;
}

/** Drains the outbox, then pulls what changed on Google's side. */
export async function syncNow(
  options: { limit?: number; signal?: AbortSignal; pull?: boolean } = {},
): Promise<Result<SyncRunSummary>> {
  const worker = getSync();
  const queue = await worker.processQueue({ limit: options.limit, signal: options.signal });
  if (queue.skipped === 'offline') {
    return fail('offline', "You're offline. I'll sync as soon as you're back.");
  }

  if (options.pull === false) return ok({ queue, pull: null });

  const pull = await worker.pullRemoteChanges(undefined, options.signal);
  if (!pull.ok) {
    // The push half already landed; a failed pull is worth reporting but the
    // outbox result must not be thrown away with it.
    log.warn('calendar pull failed', pull.error.message);
    return ok({ queue, pull: null });
  }
  return ok({ queue, pull: pull.value });
}

/**
 * The background entry point.
 *
 * `src/services/background/tasks.ts` resolves a sync function by name off this
 * module (`syncCalendar`, `runCalendarSync`, `sync`) when the OS wakes us, and
 * logs "no sync entry point" if it finds none — so the name is load-bearing.
 *
 * Nothing may escape it: a background handler that throws costs the app its
 * scheduling budget on both platforms.
 */
export async function syncCalendar(): Promise<SyncRunSummary | null> {
  try {
    const result = await syncNow();
    if (result.ok) return result.value;
    log.warn('background calendar sync did nothing', result.error.message);
    return null;
  } catch (error) {
    log.error('background calendar sync failed', error);
    return null;
  }
}

export async function status(): Promise<SyncStatusSnapshot & ConnectionSnapshot> {
  const [snapshot, connected, email, nativeMirror] = await Promise.all([
    getSync().syncStatus(),
    isSignedIn(),
    getAccountEmail(),
    hasNativePermission(),
  ]);
  const calendarId = await getRepositories().settings.get('googleCalendarId');

  return { ...snapshot, configured: isConfigured(), connected, email, calendarId, nativeMirror };
}

/**
 * Queues one event for syncing. Called by the LLM executor right after it
 * writes a row — including *before* a hard delete, so the payload can still
 * capture the remote ids the retraction needs.
 */
export async function enqueueEventSync(
  eventId: string,
  operation: CalendarSyncOperation,
): Promise<Result<void>> {
  const queued = await getSync().enqueue(eventId, operation);
  return queued.ok ? ok(undefined) : queued;
}

/** Pushes a single event immediately; the queue remains the durable path. */
export async function pushEventNow(eventId: string, signal?: AbortSignal) {
  return getSync().pushEvent(eventId, signal);
}

export {
  toGoogleEvent,
  fromGoogleEvent,
  type GoogleEventResource,
  type RemoteCalendarEvent,
} from './googleApi';
export { RIDIK_CALENDAR_TITLE } from './nativeCalendar';
export {
  CALENDAR_ENTITY_TABLE,
  SYNC_OPERATIONS,
  type CalendarSyncPayload,
  type CalendarSyncOperation,
  type ProcessQueueResult,
  type PullSummary,
  type SyncStatusSnapshot,
} from './sync';
