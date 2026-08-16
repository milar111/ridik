/**
 * Device and service state — what Settings and Places have to report on.
 *
 * Deliberately **not** re-exported from `@/hooks`: reading a permission means
 * loading the native module that owns it, and putting this in the barrel would
 * drag expo-location, expo-calendar, the speech recogniser and the whole voice
 * stack into the import graph of every screen and every screen test. The two
 * screens that need it import it by path.
 *
 * The split inside each permission is intentional: **reads** go straight to the
 * module, because only the module reports `canAskAgain` (the difference between
 * "ask again" and "send them to system settings"); **requests** go through the
 * service that owns the feature, so the explanation the user is shown and the
 * order the two location prompts arrive in stay in one place.
 */
import { useEffect, useState } from 'react';
import * as Calendar from 'expo-calendar';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { Platform } from 'react-native';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { now } from '@/core/clock';
import { createLogger, getLogEntries, subscribeToLogs, type LogEntry } from '@/core/logger';
import { formatDateTime, formatTime, todayLocalDate } from '@/core/time';
import { listUserTables, wipeAllTables } from '@/db/wipe';
import { escapeMarkdown, shareAsFile, type ShareOutcome } from '@/features/export';
// The canonical key names, imported rather than restated: a key written under a
// name the pipeline does not read is a key that silently does nothing.
import {
  LLM_API_KEY_STORE_KEY,
  WHISPER_API_KEY_STORE_KEY,
} from '@/features/voice/pipeline';
import { getRepositories } from '@/repositories';
import type { Coords } from '@/repositories/places';
import * as calendarService from '@/services/calendar';
import { ensurePermission as ensureDeviceCalendar } from '@/services/calendar/nativeCalendar';
import { backgroundStatus, type BackgroundStatus } from '@/services/background';
import {
  getGeofenceManager,
  refresh as refreshGeofenceRegions,
  status as geofenceStatus,
  type GeofenceStatus,
  type SyncSummary,
} from '@/services/geofence';
import { cancelAllScheduled, ensurePermission as ensureNotifications } from '@/services/notifications';
import { ensurePermissions as ensureMicrophone } from '@/voice/stt';

import { invalidateKeys, qk } from './keys';

const log = createLogger('settings');

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

/* ------------------------------------------------------------------ secrets */

export type SecretSlot = 'llm' | 'whisper';

/**
 * A key never leaves the keychain whole. The screen only ever needs to answer
 * "is one set, and does it look like the one I pasted", so that is all this
 * carries — a rendered string cannot be screenshotted out of the app.
 */
export type SecretState = { present: boolean; preview: string | null };

const SECRET_KEYS: Record<SecretSlot, string> = {
  llm: LLM_API_KEY_STORE_KEY,
  whisper: WHISPER_API_KEY_STORE_KEY,
};

function maskSecret(value: string): string {
  const tail = value.trim().slice(-4);
  return tail.length === 4 ? `••••••••${tail}` : '••••••••';
}

/** A keychain that will not open is a missing key, not a crash. */
async function readSecret(slot: SecretSlot): Promise<SecretState> {
  try {
    const raw = await SecureStore.getItemAsync(SECRET_KEYS[slot], SECURE_STORE_OPTIONS);
    const value = raw?.trim();
    return value ? { present: true, preview: maskSecret(value) } : { present: false, preview: null };
  } catch (error) {
    log.warn('could not read a stored key', { slot, error });
    return { present: false, preview: null };
  }
}

export function useSecret(slot: SecretSlot): UseQueryResult<SecretState> {
  return useQuery({
    queryKey: qk.system.secret(slot),
    queryFn: () => readSecret(slot),
  });
}

/**
 * Writes (or clears, with `null`) one key.
 *
 * `llmApiKeyPresent` is mirrored into settings in the same breath: the prompt
 * builder and the offline notice both read that flag, and a key stored without
 * it would leave the app claiming to be offline while it happily called out.
 */
export function useSetSecret(): UseMutationResult<
  SecretState,
  Error,
  { slot: SecretSlot; value: string | null }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ slot, value }: { slot: SecretSlot; value: string | null }) => {
      const trimmed = value?.trim() ?? '';
      if (trimmed) {
        await SecureStore.setItemAsync(SECRET_KEYS[slot], trimmed, SECURE_STORE_OPTIONS);
      } else {
        await SecureStore.deleteItemAsync(SECRET_KEYS[slot], SECURE_STORE_OPTIONS);
      }
      if (slot === 'llm') {
        await getRepositories().settings.set('llmApiKeyPresent', trimmed.length > 0);
      }
      return trimmed ? { present: true, preview: maskSecret(trimmed) } : { present: false, preview: null };
    },
    onSuccess: (state, { slot }) => client.setQueryData(qk.system.secret(slot), state),
    onSettled: () => invalidateKeys(client, [qk.system.all, qk.settings.all]),
  });
}

/* ----------------------------------------------------------------- calendar */

export type CalendarConnection = Awaited<ReturnType<typeof calendarService.status>>;

export function useCalendarConnection(): UseQueryResult<CalendarConnection> {
  return useQuery({
    queryKey: qk.system.calendar(),
    queryFn: () => calendarService.status(),
  });
}

export function useConnectCalendar(): UseMutationResult<
  calendarService.ConnectionSnapshot,
  Error,
  void
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const result = await calendarService.connect();
      if (!result.ok) throw result.error;
      return result.value;
    },
    onSettled: () => invalidateKeys(client, [qk.system.all, qk.calendar.all, qk.sync.all]),
  });
}

export function useDisconnectCalendar(): UseMutationResult<void, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const result = await calendarService.disconnect();
      if (!result.ok) throw result.error;
    },
    onSettled: () => invalidateKeys(client, [qk.system.all, qk.calendar.all, qk.sync.all]),
  });
}

export function useSyncCalendarNow(): UseMutationResult<calendarService.SyncRunSummary, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const result = await calendarService.syncNow();
      if (!result.ok) throw result.error;
      return result.value;
    },
    onSettled: () => invalidateKeys(client, [qk.system.all, qk.calendar.all, qk.sync.all]),
  });
}

/* -------------------------------------------------------------- permissions */

export type PermissionId = 'microphone' | 'calendar' | 'location' | 'notifications';

/**
 * `partial` is the state that matters most and that a boolean would hide:
 * location granted only while the app is open still fires no reminders once the
 * user pockets the phone, which is the entire point of the feature.
 */
export type PermissionLevel = 'granted' | 'partial' | 'denied' | 'blocked' | 'unavailable';

export type PermissionState = {
  id: PermissionId;
  level: PermissionLevel;
  /** One line saying what this state costs the user. */
  detail: string;
};

export type PermissionMap = Record<PermissionId, PermissionState>;

const state = (id: PermissionId, level: PermissionLevel, detail: string): PermissionState => ({
  id,
  level,
  detail,
});

async function readMicrophone(): Promise<PermissionState> {
  try {
    const current = await ExpoSpeechRecognitionModule.getPermissionsAsync();
    if (current.granted) return state('microphone', 'granted', 'Voice capture is ready.');
    if (!current.canAskAgain) {
      return state('microphone', 'blocked', 'Turn on Microphone and Speech Recognition in system settings.');
    }
    return state('microphone', 'denied', 'Without this the mic button cannot listen.');
  } catch (error) {
    log.warn('microphone permission unreadable', error);
    return state('microphone', 'unavailable', 'Speech recognition is not available on this device.');
  }
}

async function readCalendar(): Promise<PermissionState> {
  if (Platform.OS === 'web') {
    return state('calendar', 'unavailable', 'The device calendar is not available here.');
  }
  try {
    const current = await Calendar.getCalendarPermissions();
    if (current.granted) return state('calendar', 'granted', 'Events are mirrored to your device calendar.');
    if (!current.canAskAgain) {
      return state('calendar', 'blocked', 'Turn on Calendars in system settings to mirror events.');
    }
    return state('calendar', 'denied', 'Events stay inside Ridik until you allow this.');
  } catch (error) {
    log.warn('calendar permission unreadable', error);
    return state('calendar', 'unavailable', 'Calendar access could not be checked.');
  }
}

async function readLocation(): Promise<PermissionState> {
  try {
    const foreground = await Location.getForegroundPermissionsAsync();
    if (!foreground.granted) {
      return foreground.canAskAgain
        ? state('location', 'denied', 'Place reminders need location access.')
        : state('location', 'blocked', 'Turn on Location in system settings.');
    }
    const background = await Location.getBackgroundPermissionsAsync();
    if (background.granted) {
      return state('location', 'granted', 'Place reminders fire even with Ridik closed.');
    }
    return state(
      'location',
      'partial',
      'Only while Ridik is open. "Always" is what makes a place reminder arrive in your pocket.',
    );
  } catch (error) {
    log.warn('location permission unreadable', error);
    return state('location', 'unavailable', 'Location is not available on this device.');
  }
}

async function readNotifications(): Promise<PermissionState> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return state('notifications', 'granted', 'Reminders and the briefing can reach you.');
    if (!current.canAskAgain) {
      return state('notifications', 'blocked', 'Turn on Notifications in system settings.');
    }
    return state('notifications', 'denied', 'Reminders will be written but never shown.');
  } catch (error) {
    log.warn('notification permission unreadable', error);
    return state('notifications', 'unavailable', 'Notifications could not be checked.');
  }
}

export function usePermissions(): UseQueryResult<PermissionMap> {
  return useQuery({
    queryKey: qk.system.permissions(),
    queryFn: async (): Promise<PermissionMap> => {
      const [microphone, calendar, location, notifications] = await Promise.all([
        readMicrophone(),
        readCalendar(),
        readLocation(),
        readNotifications(),
      ]);
      return { microphone, calendar, location, notifications };
    },
  });
}

/**
 * Raises the system prompt for one permission. A refusal is a normal outcome,
 * not an error: the refreshed `usePermissions` row is what the screen reacts
 * to, so this resolves either way.
 */
export function useRequestPermission(): UseMutationResult<void, Error, PermissionId> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: PermissionId) => {
      if (id === 'microphone') await ensureMicrophone();
      else if (id === 'calendar') await ensureDeviceCalendar();
      else if (id === 'location') await getGeofenceManager().ensurePermissions();
      else await ensureNotifications({ prompt: true });
    },
    onSettled: () => invalidateKeys(client, [qk.system.all]),
  });
}

/* --------------------------------------------------------------- background */

export function useBackgroundStatus(): UseQueryResult<BackgroundStatus> {
  return useQuery({
    queryKey: qk.system.background(),
    queryFn: () => backgroundStatus(),
  });
}

/* ---------------------------------------------------------------- geofences */

/** What the OS is actually watching, as opposed to what the database wants. */
export function useGeofenceStatus(): UseQueryResult<GeofenceStatus> {
  return useQuery({
    queryKey: qk.system.geofence(),
    queryFn: () => geofenceStatus(),
  });
}

export function useRefreshGeofences(): UseMutationResult<SyncSummary, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const result = await refreshGeofenceRegions();
      if (!result.ok) throw result.error;
      return result.value;
    },
    onSettled: () => invalidateKeys(client, [qk.system.all, qk.geofences.all]),
  });
}

/* ----------------------------------------------------------------- location */

/**
 * One fix, now. Prompts for foreground access first — this is only ever called
 * from a button the user just pressed, so a dialog here is expected.
 */
export function useCurrentPosition(): UseMutationResult<Coords, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<Coords> => {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        throw new Error('Ridik needs location access to drop a pin where you are.');
      }
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      return { latitude: position.coords.latitude, longitude: position.coords.longitude };
    },
    onSettled: () => invalidateKeys(client, [qk.system.permissions()]),
  });
}

/** Best-effort street address for a pin. Null is a normal answer at sea. */
export function useReverseGeocode(): UseMutationResult<string | null, Error, Coords> {
  return useMutation({
    mutationFn: async (coords: Coords) => {
      const [match] = await Location.reverseGeocodeAsync(coords);
      if (!match) return null;
      const parts = [
        [match.streetNumber, match.street].filter(Boolean).join(' '),
        match.city ?? match.subregion,
        match.postalCode,
        match.country,
      ].filter((part): part is string => Boolean(part && part.trim()));
      return parts.length > 0 ? parts.join(', ') : (match.name ?? null);
    },
  });
}

/**
 * An address to a pin, for places you are not standing in.
 *
 * The counterpart to reverse geocoding, and the reason the sheet does not need
 * a latitude field: "Technical University, Sofia" is something a person can
 * check by reading it, and a wrong digit in 42.6501 is not.
 */
export function useGeocodeAddress(): UseMutationResult<
  { coords: Coords; address: string } | null,
  Error,
  string
> {
  return useMutation({
    mutationFn: async (query: string) => {
      const trimmed = query.trim();
      if (!trimmed) return null;
      const [match] = await Location.geocodeAsync(trimmed);
      if (!match) return null;
      return {
        coords: { latitude: match.latitude, longitude: match.longitude },
        address: trimmed,
      };
    },
  });
}

/* ----------------------------------------------------------------- database */

export type TableCount = { table: string; rows: number };

export type DatabaseStats = {
  bytes: number;
  totalRows: number;
  tables: TableCount[];
  schemaVersion: number;
};

export function useDatabaseStats(): UseQueryResult<DatabaseStats> {
  return useQuery({
    queryKey: qk.system.database(),
    queryFn: async (): Promise<DatabaseStats> => {
      const client = getRepositories().db.$client;
      const pageCount = client.getFirstSync<{ page_count: number }>('PRAGMA page_count', []);
      const pageSize = client.getFirstSync<{ page_size: number }>('PRAGMA page_size', []);
      const version = client.getFirstSync<{ user_version: number }>('PRAGMA user_version', []);

      // The same list the wipe walks, so the count shown and the rows erased
      // can never describe two different databases.
      const names = listUserTables(client);

      const tables: TableCount[] = [];
      for (const table of names) {
        // The name comes from sqlite_master, never from user input, so the
        // interpolation cannot be anything but an existing table.
        const row = client.getFirstSync<{ n: number }>(`SELECT count(*) AS n FROM "${table}"`, []);
        tables.push({ table, rows: row?.n ?? 0 });
      }
      tables.sort((a, b) => b.rows - a.rows || a.table.localeCompare(b.table));

      return {
        bytes: (pageCount?.page_count ?? 0) * (pageSize?.page_size ?? 0),
        totalRows: tables.reduce((sum, t) => sum + t.rows, 0),
        tables,
        schemaVersion: version?.user_version ?? 0,
      };
    },
  });
}

/**
 * Empties every table, then hands the regions back to the OS and drops the
 * queued notifications. The wipe itself lives in `@/db/wipe` so it can be run
 * against a real SQLite database in the logic suite.
 *
 * "Every table" has two documented exceptions, both spend controls rather than
 * anything the user wrote — see `PRESERVED_TABLES` in that file. This button
 * used to reset the free trial and the whole spend meter along with the notes,
 * which made it a one-tap way to buy another 25 requests on somebody else's
 * key at the price of a database the person doing it did not want.
 */
export function useEraseAllData(): UseMutationResult<number, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const cleared = wipeAllTables(getRepositories().db.$client);

      // Best effort, and in this order: a region still armed after the trigger
      // behind it is gone would fire a reminder nobody can explain.
      await refreshGeofenceRegions().catch(() => undefined);
      await cancelAllScheduled();

      return cleared;
    },
    // Nothing the user can see survived, so nothing cached is true any more.
    onSettled: () => invalidateKeys(client, [qk.all]),
  });
}

/* ------------------------------------------------------------------- export */

/**
 * The whole database as one markdown document.
 *
 * Written row by row rather than as a table dump: the point of the export is
 * that the user can read it, paste it into anything, and still have their data
 * if this app disappears.
 */
async function buildFullExport(): Promise<string> {
  const repos = getRepositories();
  const lines: string[] = [`# Ridik export`, '', `Generated ${formatDateTime(now())}`, ''];

  const section = (title: string) => {
    lines.push(`## ${title}`, '');
  };
  const empty = () => {
    lines.push('_Nothing saved._', '');
  };

  const tasks = await repos.tasks.listTasks({});
  section(`Tasks (${tasks.length})`);
  if (tasks.length === 0) empty();
  for (const task of tasks) {
    const due = task.dueDate ? ` — due ${formatDateTime(task.dueDate)}` : '';
    lines.push(`- [${task.isCompleted ? 'x' : ' '}] ${escapeMarkdown(task.title)}${due}`);
  }
  if (tasks.length > 0) lines.push('');

  const notes = await repos.notes.listNotes({ includeArchived: true });
  section(`Notes (${notes.length})`);
  if (notes.length === 0) empty();
  for (const note of notes) {
    lines.push(`### ${escapeMarkdown(note.titleSummary)}`, '', `Tag: ${escapeMarkdown(note.categoryTag)}`, '');
    for (const bullet of note.bullets) {
      const box = bullet.bulletKind === 'todo' ? `[${bullet.isCompleted ? 'x' : ' '}] ` : '';
      lines.push(`- ${box}${escapeMarkdown(bullet.content)}`);
    }
    lines.push('');
  }

  const lists = await repos.checklists.listNames();
  section(`Checklists (${lists.length})`);
  if (lists.length === 0) empty();
  for (const list of lists) {
    lines.push(`### ${escapeMarkdown(list.name)} — ${list.open} of ${list.total} open`, '');
    for (const item of await repos.checklists.itemsForList(list.name)) {
      const quantity = item.quantity ? ` (${escapeMarkdown(item.quantity)})` : '';
      lines.push(`- [${item.isCompleted ? 'x' : ' '}] ${escapeMarkdown(item.itemText)}${quantity}`);
    }
    lines.push('');
  }

  const projects = await repos.projects.listProjects();
  section(`Projects (${projects.length})`);
  if (projects.length === 0) empty();
  for (const project of projects) {
    lines.push(`- ${escapeMarkdown(project.name)} — ${project.kind}, ${project.status}`);
  }
  if (projects.length > 0) lines.push('');

  const curriculum = await repos.curriculum.listEntries();
  section(`Weekly programme (${curriculum.length})`);
  if (curriculum.length === 0) empty();
  for (const entry of curriculum) {
    const where = entry.location ? ` · ${escapeMarkdown(entry.location)}` : '';
    const who = entry.teacher ? ` · ${escapeMarkdown(entry.teacher)}` : '';
    const parity = entry.weekParity === 'every' ? '' : ` · ${entry.weekParity} weeks`;
    lines.push(
      `- ${DAY_NAMES[entry.dayOfWeek] ?? '?'} ${entry.startTime}–${entry.endTime} ` +
        `${escapeMarkdown(entry.subjectName)}${where}${who}${parity}`,
    );
  }
  if (curriculum.length > 0) lines.push('');

  const places = await repos.places.listPlaces();
  const triggers = await repos.geofences.listAllTriggers();
  section(`Places (${places.length}) and reminders (${triggers.length})`);
  if (places.length === 0 && triggers.length === 0) empty();
  for (const place of places) {
    const address = place.address ? ` — ${escapeMarkdown(place.address)}` : '';
    lines.push(
      `- ${escapeMarkdown(place.label)}: ${place.latitude.toFixed(5)}, ` +
        `${place.longitude.toFixed(5)} (${place.radiusMeters} m)${address}`,
    );
  }
  for (const trigger of triggers) {
    lines.push(
      `- ${trigger.triggerType} ${escapeMarkdown(trigger.label)}: ${escapeMarkdown(trigger.actionDescription)}`,
    );
  }
  if (places.length > 0 || triggers.length > 0) lines.push('');

  const habits = await repos.habits.listHabits({ includeArchived: true });
  section(`Habits (${habits.length})`);
  if (habits.length === 0) empty();
  for (const habit of habits) {
    lines.push(
      `- ${escapeMarkdown(habit.name)} — streak ${habit.currentStreak ?? 0}, best ${habit.longestStreak}`,
    );
  }
  if (habits.length > 0) lines.push('');

  const transactions = await repos.ledger.listRecent(1000);
  section(`Ledger (${transactions.length})`);
  if (transactions.length === 0) empty();
  for (const tx of transactions) {
    const who = tx.entityName ? ` · ${escapeMarkdown(tx.entityName)}` : '';
    lines.push(
      `- ${tx.localDate || todayLocalDate()} · ${tx.direction} ${tx.amount} ${tx.currency} · ` +
        `${escapeMarkdown(tx.category)}${who}`,
    );
  }
  if (transactions.length > 0) lines.push('');

  const people = await repos.crm.listEntities();
  section(`People (${people.length})`);
  if (people.length === 0) empty();
  for (const person of people) {
    lines.push(
      `- ${escapeMarkdown(person.entity.name)} — ${person.openCommitments} open, ` +
        `${person.interactionCount} interactions`,
    );
  }
  if (people.length > 0) lines.push('');

  const at = now();
  const year = 365 * 86_400_000;
  const events = await repos.calendar.listBetween(at - year, at + year);
  section(`Calendar (${events.length})`);
  if (events.length === 0) empty();
  for (const event of events) {
    lines.push(`- ${formatDateTime(event.startsAt)}–${formatTime(event.endsAt)} ${escapeMarkdown(event.title)}`);
  }
  if (events.length > 0) lines.push('');

  const activity = await repos.activity.listRecent(500);
  section(`Activity (${activity.length})`);
  if (activity.length === 0) empty();
  for (const entry of activity) {
    lines.push(`- ${formatDateTime(entry.loggedAt)} ${escapeMarkdown(entry.description)}`);
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function useExportEverything(): UseMutationResult<ShareOutcome, Error, void> {
  return useMutation({
    mutationFn: async () => {
      const markdown = await buildFullExport();
      const shared = await shareAsFile(markdown, `ridik-${todayLocalDate()}.md`, {
        dialogTitle: 'Export everything',
      });
      if (!shared.ok) throw shared.error;
      return shared.value;
    },
  });
}

/* -------------------------------------------------------------- diagnostics */

/**
 * The in-memory log tail.
 *
 * Not a query: the buffer is a ring that mutates in place, so there is no new
 * reference for React to notice. The subscription copies the tail on each write
 * instead, which is cheap at 300 entries and is the only way the screen updates
 * while the user is watching a sync fail.
 */
export function useLogEntries(limit = 80): readonly LogEntry[] {
  const [entries, setEntries] = useState<readonly LogEntry[]>(() => getLogEntries().slice(-limit));
  useEffect(() => {
    setEntries(getLogEntries().slice(-limit));
    return subscribeToLogs(() => setEntries(getLogEntries().slice(-limit)));
  }, [limit]);
  return entries;
}

export type { BackgroundStatus, GeofenceStatus, LogEntry };
