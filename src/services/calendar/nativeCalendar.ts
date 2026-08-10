/**
 * The device-calendar mirror.
 *
 * Everything Ridik schedules is written into a calendar of our own named
 * "Ridik", so the events show up in Apple Calendar, Samsung Calendar, a car
 * head unit, a watch face — anywhere the OS surfaces calendars — without us
 * writing an integration for each.
 *
 * A separate calendar (rather than the user's default) is deliberate: it can be
 * hidden with one toggle, and deleting it removes exactly our events and
 * nothing of theirs.
 *
 * Calendar access is optional. Every function returns a Result and the caller
 * is expected to carry on with local-only events when access is refused.
 */
import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';

import { createLogger } from '@/core/logger';
import { err, fail, ok, toAppError, type Result } from '@/core/result';
import type { CalendarEvent } from '@/db/schema';

const log = createLogger('native-calendar');

export const RIDIK_CALENDAR_TITLE = 'Ridik';
const RIDIK_CALENDAR_COLOR = '#7C5CFF';

const PERMISSION_MESSAGE =
  'Ridik needs calendar access to put your events on the device calendar. Enable it in Settings.';

let calendarId: string | null = null;

/** Test/reset hook — forces the next call to re-resolve the calendar. */
export function resetCalendarCache(): void {
  calendarId = null;
}

function unavailable(): Result<never> | null {
  return Platform.OS === 'web'
    ? fail('unsupported', 'The device calendar is not available here.')
    : null;
}

/** True when access was already granted. Never prompts — safe in the background. */
export async function hasPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const current = await Calendar.getCalendarPermissions();
    return current.granted;
  } catch (error) {
    log.warn('could not read calendar permission', error);
    return false;
  }
}

export async function ensurePermission(): Promise<Result<true>> {
  const blocked = unavailable();
  if (blocked) return blocked;

  try {
    const current = await Calendar.getCalendarPermissions();
    if (current.granted) return ok(true);
    if (!current.canAskAgain) return fail('permission_denied', PERMISSION_MESSAGE);

    const asked = await Calendar.requestCalendarPermissions();
    return asked.granted ? ok(true) : fail('permission_denied', PERMISSION_MESSAGE);
  } catch (error) {
    log.error('calendar permission check failed', error);
    return err(toAppError(error, 'Could not check calendar access.'));
  }
}

/**
 * The id of our calendar, creating it on first use.
 *
 * The source matters more than it looks: on iOS a calendar built on a source
 * the OS does not recognise silently disappears, and on Android a calendar
 * whose account does not exist is deleted by the provider on the next sync. So
 * iOS reuses the default calendar's source (falling back to a local one) and
 * Android declares an explicit LOCAL account that belongs to nobody else.
 */
export async function getOrCreateRidikCalendar(): Promise<Result<string>> {
  if (calendarId) return ok(calendarId);

  const blocked = unavailable();
  if (blocked) return blocked;
  // `hasPermission`, never `ensurePermission`: the sync worker reaches this
  // from a background wake, and a permission dialog raised there is a dialog
  // nobody is looking at — it is dismissed by the OS and counts as a refusal.
  // The interactive grant belongs to `connect()`, which asks first.
  if (!(await hasPermission())) return fail('permission_denied', PERMISSION_MESSAGE);

  try {
    const calendars = await Calendar.getCalendars(Calendar.EntityTypes.EVENT);
    const existing = calendars.find(
      (candidate) => candidate.title === RIDIK_CALENDAR_TITLE && candidate.allowsModifications,
    );
    if (existing) {
      calendarId = existing.id;
      return ok(existing.id);
    }

    const created = await Calendar.createCalendar({
      title: RIDIK_CALENDAR_TITLE,
      color: RIDIK_CALENDAR_COLOR,
      entityType: Calendar.EntityTypes.EVENT,
      source: await resolveSource(),
      // Android-only fields; harmlessly ignored on iOS.
      name: RIDIK_CALENDAR_TITLE,
      ownerAccount: RIDIK_CALENDAR_TITLE,
      accessLevel: Calendar.CalendarAccessLevel.OWNER,
    });
    calendarId = created.id;
    log.info('created the Ridik device calendar', { id: created.id });
    return ok(created.id);
  } catch (error) {
    log.error('could not resolve the Ridik calendar', error);
    return err(toAppError(error, 'Could not set up the Ridik calendar on this device.'));
  }
}

async function resolveSource(): Promise<Calendar.Source> {
  const local: Calendar.Source = {
    isLocalAccount: true,
    name: RIDIK_CALENDAR_TITLE,
    type: Calendar.SourceType.LOCAL,
  };
  if (Platform.OS !== 'ios') return local;

  try {
    // iCloud (or whatever the user's default is) so the calendar follows them
    // to their other devices; a purely local calendar would not.
    const fallback = Calendar.getDefaultCalendarSync().source;
    if (fallback) return fallback;
  } catch (error) {
    log.warn('no default calendar source; falling back to a local one', error);
  }
  try {
    const localSource = Calendar.getSourcesSync().find(
      (source) => source.type === Calendar.SourceType.LOCAL,
    );
    if (localSource) return localSource;
  } catch {
    // getSourcesSync throws when the app has write-only access.
  }
  return local;
}

/**
 * Writes the row into the device calendar, returning the native event id.
 *
 * Updates fall back to a create: a user who deleted the event in Apple Calendar
 * leaves us holding a dead id, and the next edit should put the event back
 * rather than fail forever.
 */
export async function upsertEvent(
  row: CalendarEvent,
  nativeId?: string | null,
): Promise<Result<string>> {
  const blocked = unavailable();
  if (blocked) return blocked;

  const details = toNativeEvent(row);

  if (nativeId) {
    try {
      const event = await Calendar.ExpoCalendarEvent.get(nativeId);
      await event.update(details);
      return ok(nativeId);
    } catch (error) {
      log.warn('native event vanished; recreating it', { nativeId, error });
    }
  }

  const target = await getOrCreateRidikCalendar();
  if (!target.ok) return target;

  try {
    const calendar = await Calendar.ExpoCalendar.get(target.value);
    const created = await calendar.createEvent(details);
    return ok(created.id);
  } catch (error) {
    log.error('could not write the event to the device calendar', error);
    return err(toAppError(error, 'Could not add that event to your device calendar.'));
  }
}

export async function removeEvent(nativeId: string): Promise<Result<void>> {
  const blocked = unavailable();
  if (blocked) return blocked;

  try {
    const event = await Calendar.ExpoCalendarEvent.get(nativeId);
    await event.delete();
    return ok(undefined);
  } catch (error) {
    // Already gone is the outcome we wanted.
    log.debug('native event delete was a no-op', { nativeId, error });
    return ok(undefined);
  }
}

/**
 * The shape expo-calendar wants from a row. Only the fields we own are listed:
 * anything else (alarms the user added by hand, availability) stays untouched
 * on an update.
 */
export function toNativeEvent(row: CalendarEvent) {
  return {
    title: row.title,
    notes: row.description ?? '',
    location: row.location ?? null,
    startDate: new Date(row.startsAt),
    endDate: new Date(Math.max(row.endsAt, row.startsAt)),
    allDay: row.allDay,
    timeZone: row.timezone,
  };
}
