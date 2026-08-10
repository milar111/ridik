/**
 * The OS-facing half of geofencing.
 *
 * `defineTask` has to run while the module is being evaluated: both platforms
 * can resume a killed app straight into this task, with no React tree and no
 * navigation, and the task must already exist by the time the bundle finishes
 * loading. That makes this file the one place in the app that runs before
 * anything else is ready, so it stays a shim — every decision lives in the
 * manager, and nothing here can throw at import time.
 */
import { createLogger } from '@/core/logger';
import type { TriggerType } from '@/repositories/geofences';
import { getActiveGeofenceManager } from './manager';

export const GEOFENCE_TASK = 'ridik.geofence.regions';
/** iOS wake channel: significant-location-change, never continuous updates. */
export const GEOFENCE_WAKE_TASK = 'ridik.geofence.wake';

const log = createLogger('geofence.task');

/** expo-location's `GeofencingEventType`, inlined so this file imports nothing native. */
const EVENT_TYPES: Record<number, TriggerType> = { 1: 'ENTER', 2: 'EXIT' };

type GeofenceEventData = {
  eventType?: number;
  region?: { identifier?: string | null } | null;
};

type TaskBody = {
  data?: unknown;
  error?: { message?: string } | null;
};

/**
 * Exported for the app's own wiring and for diagnostics; the OS reaches it
 * through `defineTask` below.
 */
export async function runGeofenceTask(body: TaskBody): Promise<void> {
  // Nothing below is allowed to reject. The OS entered this with no React tree
  // and nobody to catch it, so a rejection is an unhandled promise rejection
  // inside a background task — and the manager it calls is swappable.
  try {
    if (body.error) {
      log.error('geofence task reported an error', body.error.message ?? body.error);
      return;
    }

    const data = (body.data ?? {}) as GeofenceEventData;
    const eventType = typeof data.eventType === 'number' ? EVENT_TYPES[data.eventType] : undefined;
    const identifier = data.region?.identifier ?? null;
    if (!eventType) {
      log.warn('geofence event with no usable direction', { identifier });
      return;
    }

    const manager = getActiveGeofenceManager();
    if (!manager) {
      // Only reachable if the OS delivered an event before the facade module
      // was evaluated, which would mean the app was launched without it in the
      // graph.
      log.error('geofence event with no manager registered', { identifier });
      return;
    }

    const result = await manager.handleRegionEvent({ eventType, identifier });
    if (!result.ok) log.error('geofence event failed', result.error.userMessage);
    else log.debug('geofence event handled', { identifier, reason: result.value.reason });
  } catch (error) {
    log.error('geofence task threw', error);
  }
}

/**
 * The wake task exists to re-pick the twenty regions as the user moves; it
 * carries no location payload of its own that we care about.
 */
export async function runWakeTask(): Promise<void> {
  try {
    const manager = getActiveGeofenceManager();
    if (!manager) return;
    const result = await manager.syncRegions();
    if (!result.ok) log.warn('wake resync failed', result.error.userMessage);
  } catch (error) {
    log.error('wake task threw', error);
  }
}

let registered = false;

/**
 * Guarded on every axis that can fail: the task runner is a native module, so
 * it is absent under Jest and on web, and Fast Refresh re-evaluates this module
 * while the tasks it defined are still alive.
 */
export function registerGeofenceTasks(): boolean {
  if (registered) return true;
  try {
    // Required lazily, and only inside the guard, so that importing this module
    // in an environment without the native runner is a no-op instead of a crash.
    const TaskManager = require('expo-task-manager') as typeof import('expo-task-manager');
    if (typeof TaskManager?.defineTask !== 'function') return false;

    if (!TaskManager.isTaskDefined(GEOFENCE_TASK)) {
      TaskManager.defineTask(GEOFENCE_TASK, runGeofenceTask);
    }
    if (!TaskManager.isTaskDefined(GEOFENCE_WAKE_TASK)) {
      TaskManager.defineTask(GEOFENCE_WAKE_TASK, runWakeTask);
    }
    registered = true;
    return true;
  } catch (error) {
    log.warn('geofence tasks could not be defined', error);
    return false;
  }
}

registerGeofenceTasks();
