/**
 * Everything the app has to do while nobody is looking at it: the periodic OS
 * wake, the daily briefing, and re-arming the geofences the OS forgot.
 *
 * All of it is best-effort by design. Background refresh can be switched off
 * per-app on both platforms and there is no way to ask for it back, so each
 * piece degrades on its own and the Settings screen reports what the OS
 * actually allows via `backgroundStatus()`.
 */
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { createLogger } from '@/core/logger';
import { fail, ok, type Result } from '@/core/result';
import { cancelForEntity, configureNotifications, listScheduled } from '@/services/notifications';
import { registerBootstrapStep } from '@/startup/bootstrap';

import { BRIEFING_ENTITY_ID, cancelScheduledBriefing } from './briefingScheduler';
import { BACKGROUND_SYNC_TASK, defineBackgroundTasks, runBackgroundSync } from './tasks';

/**
 * The floor both operating systems enforce. Asking for less does not make wakes
 * more frequent, it just makes the number in this file a lie — iOS in
 * particular batches background work into its own windows regardless.
 */
export const MINIMUM_INTERVAL_MINUTES = 15;

const log = createLogger('background');

/** The OS's own verdict, kept separate from whether *we* managed to register. */
export type BackgroundAvailability = 'available' | 'restricted' | 'unknown';

export type BackgroundWorkRegistration = {
  taskRegistered: boolean;
  availability: BackgroundAvailability;
  /** UTC epoch ms of the briefing this call booked, if any. */
  briefingAt: number | null;
  geofencesResumed: number;
};

let pending: Promise<Result<BackgroundWorkRegistration>> | null = null;

/**
 * Idempotent: the memoised promise makes a second call during the same session
 * a no-op, and re-entry from a Fast Refresh cheap. A *failed* attempt is not
 * cached, because the usual cause is a permission the user can still grant.
 */
export async function registerBackgroundWork(): Promise<Result<BackgroundWorkRegistration>> {
  if (!pending) {
    pending = performRegistration().then((result) => {
      if (!result.ok) pending = null;
      return result;
    });
  }
  return pending;
}

async function performRegistration(): Promise<Result<BackgroundWorkRegistration>> {
  try {
    defineBackgroundTasks();
    await configureNotifications();

    const osStatus = await readOsStatus();
    const taskRegistered = (await isTaskManagerAvailable())
      ? await ensureTaskRegistered(osStatus)
      : false;

    // Both of these are OS-side and keep firing even when background refresh is
    // switched off for the app, so neither is gated on `taskRegistered`.
    const briefing = await cancelScheduledBriefing();
    if (!briefing.ok) {
      // Not having notification permission yet is the normal state on a first
      // launch, not a fault; logging it as a warning fills the user-facing
      // diagnostics log with noise and buries the failures that do matter.
      const expected = briefing.error.code === 'permission_denied';
      const note = 'briefing not scheduled';
      if (expected) log.info(note, briefing.error.message);
      else log.warn(note, briefing.error.message);
    }
    const geofencesResumed = await resumeGeofences();

    const registration: BackgroundWorkRegistration = {
      taskRegistered,
      availability: describeStatus(osStatus),
      briefingAt: briefing.ok ? briefing.value.at : null,
      geofencesResumed,
    };
    log.info('background work registered', registration);
    return ok(registration);
  } catch (error) {
    log.error('background registration failed', error);
    return fail('unknown', 'Background updates could not be set up.', { cause: error });
  }
}

/** Removes the OS registration and the queued briefing. Safe to call twice. */
export async function unregisterBackgroundWork(): Promise<Result<true>> {
  try {
    if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK).catch(() => false)) {
      await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
    }
    await cancelForEntity(BRIEFING_ENTITY_ID);
    pending = null;
    return ok(true);
  } catch (error) {
    log.error('background unregistration failed', error);
    return fail('unknown', 'Background updates could not be turned off.', { cause: error });
  }
}

export type BackgroundStatus = {
  availability: BackgroundAvailability;
  /** The raw `BackgroundTaskStatus` the OS reported, for the diagnostics list. */
  osStatus: BackgroundTask.BackgroundTaskStatus | null;
  taskRegistered: boolean;
  /** UTC epoch ms of the briefing actually sitting in the OS queue. */
  briefingAt: number | null;
  intervalMinutes: number;
};

/**
 * What Settings shows. Read back from the OS rather than from our own state:
 * the user can revoke background refresh in system settings at any time, and
 * the point of this screen is to explain why nothing has updated.
 */
export async function backgroundStatus(): Promise<BackgroundStatus> {
  const [osStatus, taskRegistered, briefingAt] = await Promise.all([
    readOsStatus(),
    TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK).catch(() => false),
    scheduledBriefingAt(),
  ]);
  return {
    availability: describeStatus(osStatus),
    osStatus,
    taskRegistered,
    briefingAt,
    intervalMinutes: MINIMUM_INTERVAL_MINUTES,
  };
}

async function readOsStatus(): Promise<BackgroundTask.BackgroundTaskStatus | null> {
  try {
    return await BackgroundTask.getStatusAsync();
  } catch (error) {
    log.warn('background status unavailable', error);
    return null;
  }
}

async function isTaskManagerAvailable(): Promise<boolean> {
  // False on web and on Expo Go/Android, where defining the task above already
  // no-opped; registering anyway would throw on every launch.
  return TaskManager.isAvailableAsync().catch(() => false);
}

/**
 * Registers the OS task — unless the OS has already told us it will not run one.
 *
 * `registerTaskAsync` does **not** throw on a device reporting `Restricted`. It
 * writes a `console.warn` and returns, having registered nothing, so the old
 * unconditional call cost two things. The visible one was a warning on every
 * launch of every iOS simulator, which is the one environment where background
 * refresh is *always* restricted. The one that mattered was silent:
 * `taskRegistered: true` was then reported for a task that does not exist, and
 * that flag is read straight out onto `app/developer.tsx`. A read-out that
 * cannot say whether it is bad is a decoration.
 *
 * `osStatus` is passed in rather than read again — `performRegistration` has
 * already asked, and asking twice is how the two answers start disagreeing.
 *
 * The order matters: a task registered while the OS was still `Available` stays
 * registered after the user revokes background refresh, so "already registered"
 * is checked *before* the restriction and is still the honest answer.
 */
async function ensureTaskRegistered(
  osStatus: BackgroundTask.BackgroundTaskStatus | null,
): Promise<boolean> {
  try {
    if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)) return true;
    if (osStatus === BackgroundTask.BackgroundTaskStatus.Restricted) return false;
    await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, {
      minimumInterval: MINIMUM_INTERVAL_MINUTES,
    });
    return true;
  } catch (error) {
    log.warn('background task registration failed', error);
    return false;
  }
}

function describeStatus(
  status: BackgroundTask.BackgroundTaskStatus | null,
): BackgroundAvailability {
  if (status === BackgroundTask.BackgroundTaskStatus.Restricted) return 'restricted';
  if (status === BackgroundTask.BackgroundTaskStatus.Available) return 'available';
  return 'unknown';
}

async function scheduledBriefingAt(): Promise<number | null> {
  for (const request of await listScheduled()) {
    const data = request.content.data as { entityId?: unknown } | undefined;
    if (data?.entityId !== BRIEFING_ENTITY_ID) continue;
    const at = dateTriggerValue(request.trigger);
    if (at !== null) return at;
  }
  return null;
}

/** The trigger union differs per platform; only the date form carries an instant. */
function dateTriggerValue(trigger: unknown): number | null {
  if (typeof trigger !== 'object' || trigger === null) return null;
  const shape = trigger as { type?: unknown; value?: unknown };
  return shape.type === 'date' && typeof shape.value === 'number' ? shape.value : null;
}

/**
 * Geofences live in the OS, and a reboot, an app update or a revoked permission
 * empties that list without telling us. Startup hands them back.
 *
 * Imported at call time because evaluating the geofence facade binds native
 * location: a device that refuses that must still get its briefing. The re-diff
 * is cheap when the monitored set already matches.
 */
async function resumeGeofences(): Promise<number> {
  try {
    const geofence = await import('@/services/geofence');
    const summary = await geofence.refresh();
    if (summary.ok) return summary.value.monitored;
    log.info('geofences not resumed', summary.error.userMessage);
  } catch (error) {
    log.warn('geofencing unavailable', error);
  }
  return 0;
}

registerBootstrapStep({
  name: 'background',
  run: () => {
    // Deliberately not awaited. Booking the briefing can raise the notification
    // permission dialog, and the splash screen must not sit behind a modal the
    // user might take a minute to answer.
    void registerBackgroundWork();
  },
});

export {
  BACKGROUND_SYNC_TASK,
  BRIEFING_ENTITY_ID,
  runBackgroundSync,
  cancelScheduledBriefing,
};
export { briefingBody, nextBriefingAt } from './briefingScheduler';
export type { BriefingSchedule, DaySummary, NextBriefingInput } from './briefingScheduler';
export type { BackgroundSyncOutcome } from './tasks';
