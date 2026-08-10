/**
 * The calendar sync worker.
 *
 * Writes never wait on the network: the repository stores the row, something
 * enqueues an outbox entry, and this drains it later. That ordering is what
 * makes "move my 3 PM to 4" instant on a train with no signal.
 *
 * Everything the worker touches that is not the database arrives as an injected
 * bridge. That keeps the module loadable — and the whole state machine
 * testable — under plain Node, and it is the only way to assert the retry and
 * conflict behaviour without a phone.
 */
import { desc, eq } from 'drizzle-orm';

import { now } from '@/core/clock';
import type { Logger } from '@/core/logger';
import { AppError, err, fail, ok, toAppError, type Result } from '@/core/result';
import { appSettings, calendarEvents, type CalendarEvent } from '@/db/schema';
import type { Repositories } from '@/repositories';
import { decodePayload, type BackoffOptions, type SyncQueueEntry } from '@/repositories/syncQueue';

import {
  toGoogleEvent,
  type GoogleEventResource,
  type ListEventsPage,
  type ListEventsQuery,
  type RemoteCalendarEvent,
} from './googleApi';

/** Outbox rows this worker owns. Anything else it claims, it puts back. */
export const CALENDAR_ENTITY_TABLE = 'calendar_events';
export const SYNC_OPERATIONS = {
  /**
   * One operation for create *and* update: the queue dedupes on
   * (operation, entityId), so three quick edits collapse into one push, and
   * whether that push is a POST or a PUT is decided from the row itself.
   */
  push: 'calendar.push',
  delete: 'calendar.delete',
} as const;

/** Opaque cursors owned by this worker, not user-facing configuration, hence
 * the raw rows rather than the typed settings repository. */
export const SYNC_TOKEN_KEY = 'calendar.syncToken';
export const LAST_SYNCED_AT_KEY = 'calendar.lastSyncedAt';

export const DEFAULT_BATCH_SIZE = 20;
/** A claim older than this belonged to a worker that was killed mid-flight. */
export const STALE_CLAIM_MS = 5 * 60_000;
/** Default pull window when there is no sync token to work from. */
export const PULL_BACK_DAYS = 7;
export const PULL_FORWARD_DAYS = 60;
const MAX_PULL_PAGES = 20;
const DAY_MS = 86_400_000;

export type CalendarSyncOperation = 'create' | 'update' | 'delete';

/**
 * Everything a retraction needs, copied at enqueue time: by the time the worker
 * runs, the local row may be gone and its remote ids with it.
 */
export type CalendarSyncPayload = {
  googleEventId?: string | null;
  googleCalendarId?: string | null;
  nativeEventId?: string | null;
};

export type GoogleBridge = {
  /** False when the user never connected Google, or signed out. */
  isConnected(): Promise<boolean>;
  /** The calendar new events go into. */
  calendarId(): Promise<Result<string>>;
  createEvent(
    calendarId: string,
    resource: GoogleEventResource,
    signal?: AbortSignal,
  ): Promise<Result<GoogleEventResource>>;
  updateEvent(
    calendarId: string,
    eventId: string,
    resource: GoogleEventResource,
    signal?: AbortSignal,
  ): Promise<Result<GoogleEventResource>>;
  deleteEvent(calendarId: string, eventId: string, signal?: AbortSignal): Promise<Result<void>>;
  listEvents(query: ListEventsQuery, signal?: AbortSignal): Promise<Result<ListEventsPage>>;
};

export type NativeBridge = {
  /** False when calendar permission was refused; the app stays local-only. */
  isAvailable(): Promise<boolean>;
  upsertEvent(row: CalendarEvent, nativeId: string | null): Promise<Result<string>>;
  removeEvent(nativeId: string): Promise<Result<void>>;
};

export type CalendarSyncDeps = {
  repositories: Pick<Repositories, 'calendar' | 'syncQueue' | 'db'>;
  google: GoogleBridge;
  native: NativeBridge;
  /** Defaults to a NetInfo probe. */
  isOnline?: () => Promise<boolean>;
  logger?: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  backoff?: BackoffOptions;
};

export type ProcessQueueResult = {
  processed: number;
  succeeded: number;
  failed: number;
  /** Why the pass did nothing, when it did nothing on purpose. */
  skipped: 'offline' | 'busy' | null;
};

export type PullSummary = {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  syncToken: string | null;
};

export type SyncStatusSnapshot = {
  pending: number;
  inFlight: number;
  failed: number;
  lastSyncedAt: number | null;
};

export function createCalendarSync(deps: CalendarSyncDeps) {
  const { calendar, syncQueue: queue, db } = deps.repositories;
  const { google, native } = deps;
  const log = deps.logger;
  const isOnline = deps.isOnline ?? netInfoIsOnline;

  /** One pass at a time per instance; two would fight over the same claims. */
  let running = false;

  /* ------------------------------------------------------------- outbox -- */

  async function enqueue(
    eventId: string,
    operation: CalendarSyncOperation,
  ): Promise<Result<SyncQueueEntry>> {
    try {
      const row = await calendar.getById(eventId);
      const entry = await queue.enqueue({
        operation: operation === 'delete' ? SYNC_OPERATIONS.delete : SYNC_OPERATIONS.push,
        entityTable: CALENDAR_ENTITY_TABLE,
        entityId: eventId,
        payload: {
          googleEventId: row?.googleEventId ?? null,
          googleCalendarId: row?.googleCalendarId ?? null,
          nativeEventId: row?.nativeEventId ?? null,
        } satisfies CalendarSyncPayload,
      });
      return ok(entry);
    } catch (error) {
      log?.error('could not queue a calendar change', error);
      return err(toAppError(error, 'Could not queue that change for syncing.'));
    }
  }

  async function processQueue(
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<ProcessQueueResult> {
    const idle: ProcessQueueResult = { processed: 0, succeeded: 0, failed: 0, skipped: null };
    if (running) return { ...idle, skipped: 'busy' };
    // Burning an attempt while the phone is in a tunnel would push the next try
    // minutes into the future for no reason; the backoff is for *server*
    // trouble, not for a radio that is off.
    if (!(await isOnline())) return { ...idle, skipped: 'offline' };

    running = true;
    let succeeded = 0;
    let failed = 0;
    let interrupted = false;

    try {
      await queue.releaseStale(now(), STALE_CLAIM_MS);
      const entries = await queue.claimReady(now(), options.limit ?? DEFAULT_BATCH_SIZE);

      for (const entry of entries) {
        if (options.signal?.aborted) {
          interrupted = true;
          break;
        }
        // Another feature's outbox row. Leave it exactly as we found it.
        if (entry.entityTable !== CALENDAR_ENTITY_TABLE) {
          interrupted = true;
          continue;
        }

        const outcome = await performEntry(entry, options.signal);
        if (outcome.ok) {
          await queue.markDone(entry.id);
          succeeded++;
          continue;
        }

        failed++;
        await queue.markFailed(entry.id, outcome.error.userMessage, deps.backoff);
        if (stopsTheBatch(outcome.error)) {
          log?.warn('stopping the sync pass early', { code: outcome.error.code });
          interrupted = true;
          break;
        }
      }

      // Hand back anything we claimed but did not attempt. Safe because this
      // instance holds the only claims: `running` serialises our own passes and
      // a crashed worker's rows were already recovered above.
      if (interrupted) await queue.releaseStale(now(), 0);
      if (succeeded > 0) await writeWorkerSetting(db, LAST_SYNCED_AT_KEY, now());

      return { processed: succeeded + failed, succeeded, failed, skipped: null };
    } finally {
      running = false;
    }
  }

  /**
   * Auth, connectivity and throttling failures are not per-entry problems:
   * every remaining entry would fail the same way and each failure costs an
   * attempt out of a budget of eight. A rate limit in particular is Google
   * asking us to stop — draining the rest of the batch into it would burn
   * twenty attempts and keep hammering the endpoint that just said no.
   */
  function stopsTheBatch(error: AppError): boolean {
    return (
      error.code === 'permission_denied' ||
      error.code === 'offline' ||
      error.code === 'rate_limited'
    );
  }

  /** A thrown database error is one entry's problem, never the pass's. */
  async function performEntry(entry: SyncQueueEntry, signal?: AbortSignal): Promise<Result<void>> {
    try {
      return await performEntryUnguarded(entry, signal);
    } catch (error) {
      log?.error('sync entry threw', { id: entry.id, error });
      return err(toAppError(error, 'Could not sync that change.'));
    }
  }

  async function performEntryUnguarded(
    entry: SyncQueueEntry,
    signal?: AbortSignal,
  ): Promise<Result<void>> {
    const payload = decodePayload<CalendarSyncPayload>(entry) ?? {};

    if (entry.operation === SYNC_OPERATIONS.delete) {
      // The payload belongs to whoever enqueued the delete and is not
      // guaranteed to carry every id — the executor's, for one, records the
      // Google ids but not the device one. A soft-deleted row is still here and
      // still knows them, so it fills the gaps rather than leaving a copy of a
      // cancelled event sitting on the user's phone forever.
      const tombstone = await calendar.getById(entry.entityId);
      return retract(
        {
          googleEventId: payload.googleEventId ?? tombstone?.googleEventId ?? null,
          googleCalendarId: payload.googleCalendarId ?? tombstone?.googleCalendarId ?? null,
          nativeEventId: payload.nativeEventId ?? tombstone?.nativeEventId ?? null,
        },
        signal,
      );
    }

    const row = await calendar.getById(entry.entityId);
    // Hard-deleted since the entry was written: the matching delete entry (if
    // any) carries the remote ids, so there is nothing left for this one to do.
    if (!row) return ok(undefined);

    if (row.deletedAt !== null) {
      const retracted = await retract(
        {
          googleEventId: row.googleEventId,
          googleCalendarId: row.googleCalendarId,
          nativeEventId: row.nativeEventId,
        },
        signal,
      );
      if (retracted.ok) await calendar.markSynced(row.id, {});
      return retracted;
    }

    const pushed = await push(row, signal);
    return pushed.ok ? ok(undefined) : pushed;
  }

  /* --------------------------------------------------------------- push -- */

  async function push(row: CalendarEvent, signal?: AbortSignal): Promise<Result<CalendarEvent>> {
    let googleEventId = row.googleEventId;
    let googleCalendarId = row.googleCalendarId;
    let nativeEventId = row.nativeEventId;

    if (await google.isConnected()) {
      const target = googleCalendarId ? ok(googleCalendarId) : await google.calendarId();
      if (!target.ok) {
        await calendar.markSyncFailed(row.id, target.error.userMessage);
        return target;
      }
      googleCalendarId = target.value;

      const written = await writeToGoogle(googleCalendarId, googleEventId, row, signal);
      if (!written.ok) {
        await calendar.markSyncFailed(row.id, written.error.userMessage);
        return written;
      }
      googleEventId = written.value.id ?? googleEventId;
    }

    if (await native.isAvailable()) {
      const mirrored = await native.upsertEvent(row, nativeEventId);
      if (mirrored.ok) nativeEventId = mirrored.value;
      // The device mirror is a convenience, not the record. A phone that
      // refuses to store the event must not block the Google push behind it.
      else log?.warn('device calendar mirror failed', { id: row.id, error: mirrored.error.message });
    }

    // With neither target configured this still resolves the row: "synced"
    // here means "nothing left to push", which is true for a local-only setup.
    return calendar.markSynced(row.id, { googleEventId, googleCalendarId, nativeEventId });
  }

  async function writeToGoogle(
    calendarId: string,
    googleEventId: string | null,
    row: CalendarEvent,
    signal?: AbortSignal,
  ): Promise<Result<GoogleEventResource>> {
    const resource = toGoogleEvent(row);
    if (!googleEventId) return google.createEvent(calendarId, resource, signal);

    const updated = await google.updateEvent(calendarId, googleEventId, resource, signal);
    if (updated.ok || updated.error.code !== 'not_found') return updated;

    // The user deleted it in Google's UI but kept it here. Recreating it is the
    // only reading of "the local row is the one that changed" that terminates.
    log?.info('recreating an event Google no longer has', { id: row.id });
    return google.createEvent(calendarId, resource, signal);
  }

  async function retract(payload: CalendarSyncPayload, signal?: AbortSignal): Promise<Result<void>> {
    if (payload.googleEventId && (await google.isConnected())) {
      const target = payload.googleCalendarId ? ok(payload.googleCalendarId) : await google.calendarId();
      if (!target.ok) return target;
      const removed = await google.deleteEvent(target.value, payload.googleEventId, signal);
      if (!removed.ok) return removed;
    }

    if (payload.nativeEventId && (await native.isAvailable())) {
      const removed = await native.removeEvent(payload.nativeEventId);
      if (!removed.ok && removed.error.retryable) return removed;
    }
    return ok(undefined);
  }

  /** Pushes one event now, outside the queue. Used by "sync this event". */
  async function pushEvent(eventId: string, signal?: AbortSignal): Promise<Result<CalendarEvent>> {
    if (!(await isOnline())) {
      return fail('offline', "You're offline. I'll sync that as soon as you're back.");
    }
    const row = await calendar.getById(eventId);
    if (!row) return fail('not_found', 'I could not find that event any more.');

    if (row.deletedAt !== null) {
      const retracted = await retract({
        googleEventId: row.googleEventId,
        googleCalendarId: row.googleCalendarId,
        nativeEventId: row.nativeEventId,
      });
      if (!retracted.ok) return retracted;
      return calendar.markSynced(row.id, {});
    }
    return push(row, signal);
  }

  /* --------------------------------------------------------------- pull -- */

  /**
   * Incremental where Google lets us: the sync token replays only what changed,
   * which on a busy calendar is the difference between a handful of rows and a
   * full re-read on every pass. Google retires tokens without warning, so an
   * expired one silently degrades to a windowed pull.
   */
  async function pullRemoteChanges(
    range?: { from: number; to: number },
    signal?: AbortSignal,
  ): Promise<Result<PullSummary>> {
    try {
      return await pull(range, signal);
    } catch (error) {
      log?.error('calendar pull threw', error);
      return err(toAppError(error, 'Could not refresh your calendar from Google.'));
    }
  }

  async function pull(
    range?: { from: number; to: number },
    signal?: AbortSignal,
  ): Promise<Result<PullSummary>> {
    const summary: PullSummary = { created: 0, updated: 0, deleted: 0, skipped: 0, syncToken: null };
    if (!(await isOnline())) {
      return fail('offline', "You're offline. I'll refresh your calendar later.");
    }
    // Local + device only. Not an error: most of the app works without Google.
    if (!(await google.isConnected())) return ok(summary);

    const target = await google.calendarId();
    if (!target.ok) return target;
    const calendarId = target.value;

    const at = now();
    const window = range ?? { from: at - PULL_BACK_DAYS * DAY_MS, to: at + PULL_FORWARD_DAYS * DAY_MS };
    let syncToken = await readWorkerSetting<string>(db, SYNC_TOKEN_KEY);
    let pageToken: string | null = null;

    for (let page = 0; page < MAX_PULL_PAGES; page++) {
      const query: ListEventsQuery = syncToken
        ? { calendarId, syncToken, ...(pageToken ? { pageToken } : {}) }
        : {
            calendarId,
            timeMin: window.from,
            timeMax: window.to,
            ...(pageToken ? { pageToken } : {}),
          };

      const fetched = await google.listEvents(query, signal);
      if (!fetched.ok) {
        if (syncToken && fetched.error.code === 'conflict') {
          log?.info('google retired our sync token; falling back to a windowed pull');
          await writeWorkerSetting(db, SYNC_TOKEN_KEY, null);
          syncToken = null;
          pageToken = null;
          continue;
        }
        return fetched;
      }

      let aborted = false;
      for (const remote of fetched.value.events) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        const applied = await applyRemote(remote, calendarId);
        summary[applied]++;
      }

      // A half-applied page must not be acknowledged. Storing the token retires
      // exactly the events we just skipped: the next incremental pull replays
      // what changed *after* it, and they are never offered again.
      if (aborted) return ok(summary);

      if (fetched.value.nextSyncToken) {
        summary.syncToken = fetched.value.nextSyncToken;
        await writeWorkerSetting(db, SYNC_TOKEN_KEY, fetched.value.nextSyncToken);
      }
      pageToken = fetched.value.nextPageToken;
      if (!pageToken) break;
      if (page === MAX_PULL_PAGES - 1) {
        // Not fatal, but the tail of the window is unread and no sync token was
        // issued, so the next pass starts over rather than continuing.
        log?.warn('calendar pull hit the page limit; the rest of the window was not read');
      }
    }

    await writeWorkerSetting(db, LAST_SYNCED_AT_KEY, now());
    return ok(summary);
  }

  async function applyRemote(
    remote: RemoteCalendarEvent,
    calendarId: string,
  ): Promise<'created' | 'updated' | 'deleted' | 'skipped'> {
    try {
      return await applyRemoteUnguarded(remote, calendarId);
    } catch (error) {
      // One conflicting row must not abandon the rest of the page.
      log?.warn('could not apply a remote event', { id: remote.googleEventId, error });
      return 'skipped';
    }
  }

  async function applyRemoteUnguarded(
    remote: RemoteCalendarEvent,
    calendarId: string,
  ): Promise<'created' | 'updated' | 'deleted' | 'skipped'> {
    const local = await findLocal(remote);

    if (remote.cancelled) {
      if (!local || local.deletedAt !== null) return 'skipped';
      await calendar.softDelete(local.id);
      // softDelete flags the row pending so the outbox would push the deletion
      // straight back to Google. This deletion *came from* Google.
      await calendar.markSynced(local.id, {});
      return 'deleted';
    }

    if (!local) {
      const created = await calendar.createEvent({
        title: remote.title,
        description: remote.description,
        location: remote.location,
        startsAt: remote.startsAt,
        endsAt: remote.endsAt,
        allDay: remote.allDay,
        timezone: remote.timezone,
        syncStatus: 'synced',
      });
      await calendar.markSynced(created.id, {
        googleEventId: remote.googleEventId,
        googleCalendarId: calendarId,
      });
      return 'created';
    }

    // Last write wins — except that an edit which has not reached Google yet is
    // newer than anything Google can tell us about, whatever the timestamps say.
    if (local.syncStatus === 'pending' || (await queue.listForEntity(local.id)).length > 0) {
      return 'skipped';
    }
    if (remote.updatedAt <= local.updatedAt) return 'skipped';

    const updated = await calendar.updateEvent(local.id, {
      title: remote.title,
      description: remote.description,
      location: remote.location,
      startsAt: remote.startsAt,
      endsAt: remote.endsAt,
      allDay: remote.allDay,
      timezone: remote.timezone,
    });
    if (!updated.ok) return 'skipped';
    await calendar.markSynced(local.id, {
      googleEventId: remote.googleEventId,
      googleCalendarId: calendarId,
    });
    return 'updated';
  }

  /**
   * Our own id first: it survives the event being edited in Google's UI, and it
   * is the only link for a row whose `google_event_id` was never written back
   * because the app was killed between the POST and the update.
   */
  async function findLocal(remote: RemoteCalendarEvent): Promise<CalendarEvent | null> {
    if (remote.ridikId) {
      const byId = await calendar.getById(remote.ridikId);
      if (byId) return byId;
    }
    const [row] = await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.googleEventId, remote.googleEventId))
      .orderBy(desc(calendarEvents.updatedAt))
      .limit(1);
    return row ?? null;
  }

  /* ------------------------------------------------------------- status -- */

  async function syncStatus(): Promise<SyncStatusSnapshot> {
    const counts = await queue.counts();
    return { ...counts, lastSyncedAt: await readWorkerSetting<number>(db, LAST_SYNCED_AT_KEY) };
  }

  return { enqueue, processQueue, pushEvent, pullRemoteChanges, syncStatus };
}

export type CalendarSync = ReturnType<typeof createCalendarSync>;

/* -------------------------------------------------------- worker settings -- */

type WorkerDb = Repositories['db'];

export async function readWorkerSetting<T>(db: WorkerDb, key: string): Promise<T | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function writeWorkerSetting(
  db: WorkerDb,
  key: string,
  value: unknown,
): Promise<void> {
  const at = now();
  if (value === null) {
    await db.delete(appSettings).where(eq(appSettings.key, key));
    return;
  }
  await db
    .insert(appSettings)
    .values({ key, value: JSON.stringify(value), updatedAt: at })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: JSON.stringify(value), updatedAt: at } });
}

/* ------------------------------------------------------------ netinfo ---- */

type NetInfoLike = {
  fetch(): Promise<{ isConnected: boolean | null; isInternetReachable: boolean | null }>;
};

let netInfo: NetInfoLike | null | undefined;

/**
 * Required lazily so this module stays loadable under plain Node (tests) and on
 * web, where the native module does not exist. An unknown state counts as
 * online: a false negative would silently stop syncing forever, while a false
 * positive costs one failed request.
 */
export async function netInfoIsOnline(): Promise<boolean> {
  if (netInfo === undefined) {
    try {
      const mod = require('@react-native-community/netinfo') as { default?: NetInfoLike } & NetInfoLike;
      netInfo = mod.default ?? mod;
    } catch {
      netInfo = null;
    }
  }
  if (!netInfo) return true;

  try {
    const state = await netInfo.fetch();
    if (state.isConnected === false) return false;
    return state.isInternetReachable !== false;
  } catch {
    return true;
  }
}
