/**
 * Background geofencing, assembled.
 *
 * This is the only file in the feature that touches a native module: the
 * manager takes the OS as a port so the twenty-region decision stays testable
 * in plain Node, and the port is bound here.
 */
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { createLogger } from '@/core/logger';
import { attempt, fail, ok, type Result } from '@/core/result';
import { getRepositories } from '@/repositories';
import { CHANNELS, ensurePermission, presentNow } from '@/services/notifications';
import { registerBootstrapStep } from '@/startup/bootstrap';
import {
  createGeofenceManager,
  setActiveGeofenceManager,
  type GeofenceStatus,
  type LocationPort,
  type MonitoredRegion,
  type NotificationPort,
  type PermissionSnapshot,
  type SyncSummary,
} from './manager';
import { GEOFENCE_TASK, GEOFENCE_WAKE_TASK, registerGeofenceTasks } from './task';

export {
  MAX_MONITORED_REGIONS,
  type GeofencePermission,
  type GeofenceStatus,
  type RegionEventOutcome,
  type SyncSummary,
} from './manager';
export { GEOFENCE_TASK, GEOFENCE_WAKE_TASK } from './task';

const log = createLogger('geofence');

/** Older than this and a cached fix says nothing about which regions are near. */
const LAST_KNOWN_MAX_AGE_MS = 15 * 60_000;
const LAST_KNOWN_REQUIRED_ACCURACY_M = 3_000;

/**
 * The iOS wake channel. Balanced accuracy with a three-kilometre filter and
 * deferred delivery leaves significant-location-change as the only thing that
 * actually reaches us — expo starts SLC monitoring alongside the update stream,
 * and everything the stream itself produces is filtered out before it costs a
 * wake-up. Continuous updates at this coarseness would drain the battery to
 * learn what the cell radio already knows.
 */
const WAKE_OPTIONS: Location.LocationTaskOptions = {
  accuracy: Location.Accuracy.Balanced,
  distanceInterval: 3_000,
  deferredUpdatesDistance: 3_000,
  deferredUpdatesInterval: 15 * 60_000,
  pausesUpdatesAutomatically: true,
  activityType: Location.ActivityType.Other,
  showsBackgroundLocationIndicator: false,
};

const snapshot = (response: {
  granted: boolean;
  canAskAgain: boolean;
}): PermissionSnapshot => ({ granted: response.granted, canAskAgain: response.canAskAgain });

const locationPort: LocationPort = {
  async isAvailable() {
    if (Platform.OS === 'web') return false;
    return TaskManager.isAvailableAsync().catch(() => false);
  },
  async getForegroundPermission() {
    return snapshot(await Location.getForegroundPermissionsAsync());
  },
  async requestForegroundPermission() {
    return snapshot(await Location.requestForegroundPermissionsAsync());
  },
  async getBackgroundPermission() {
    return snapshot(await Location.getBackgroundPermissionsAsync());
  },
  async requestBackgroundPermission() {
    return snapshot(await Location.requestBackgroundPermissionsAsync());
  },
  async getLastKnownPosition() {
    const position = await Location.getLastKnownPositionAsync({
      maxAge: LAST_KNOWN_MAX_AGE_MS,
      requiredAccuracy: LAST_KNOWN_REQUIRED_ACCURACY_M,
    }).catch(() => null);
    if (!position) return null;
    return { latitude: position.coords.latitude, longitude: position.coords.longitude };
  },
  async hasStartedGeofencing() {
    return Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
  },
  async startGeofencing(regions: MonitoredRegion[]) {
    await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
  },
  async stopGeofencing() {
    // Stopping a task the OS never started throws on both platforms, and the
    // manager is allowed to ask blindly.
    if (!(await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false))) return;
    await Location.stopGeofencingAsync(GEOFENCE_TASK);
  },
  async hasStartedWakeUpdates() {
    return Location.hasStartedLocationUpdatesAsync(GEOFENCE_WAKE_TASK).catch(() => false);
  },
  async startWakeUpdates() {
    await Location.startLocationUpdatesAsync(GEOFENCE_WAKE_TASK, WAKE_OPTIONS);
  },
  async stopWakeUpdates() {
    if (!(await Location.hasStartedLocationUpdatesAsync(GEOFENCE_WAKE_TASK).catch(() => false))) {
      return;
    }
    await Location.stopLocationUpdatesAsync(GEOFENCE_WAKE_TASK);
  },
};

const notificationPort: NotificationPort = {
  present: ({ title, body, triggerId, taskId }) =>
    presentNow({
      title,
      body,
      channel: CHANNELS.places,
      data: {
        kind: 'geofence',
        entityId: triggerId,
        href: taskId ? '/tasks' : '/places',
        ...(taskId ? { taskId } : {}),
      },
    }),
};

const manager = createGeofenceManager({
  geofences: () => getRepositories().geofences,
  location: locationPort,
  notifications: notificationPort,
  platform: Platform.OS,
  logger: log,
});

setActiveGeofenceManager(manager);
registerGeofenceTasks();

registerBootstrapStep({
  name: 'geofence',
  run: async () => {
    const result = await manager.resumeAfterRestart();
    // Not being able to re-arm is normal — no permission, no places yet — and
    // must never be allowed to hold up startup.
    if (!result.ok) log.info('geofencing not resumed', result.error.userMessage);
  },
});

export type EnableOutcome = {
  /** False when the trigger lost the twenty-region cap to nearer places. */
  watching: boolean;
  summary: SyncSummary;
};

/**
 * Turns on monitoring for one trigger: asks for whatever permission is still
 * missing, then re-diffs the whole set, because adding a region can push
 * another one over the cap.
 */
export async function enableFor(triggerId: string): Promise<Result<EnableOutcome>> {
  // Reached from a screen, so the database may not be open yet; every other
  // entry point here degrades into a Result and this one has to as well.
  const found = await attempt(() => getRepositories().geofences.getTrigger(triggerId));
  if (!found.ok) return found;
  const trigger = found.value;
  if (!trigger) return fail('not_found', 'That location reminder no longer exists.');
  // A spent one-shot and a switched-off reminder look identical to the sync,
  // which would silently report it as not being watched.
  if (!(trigger.isActive ?? true)) {
    return fail('conflict', `The reminder at ${trigger.label} is switched off.`);
  }

  const permission = await manager.ensurePermissions();
  if (!permission.ok) return permission;

  // A crossing presents through `presentNow`, which never prompts — it runs
  // from a background task where a system dialog is not on offer. Without this
  // ask, a user who granted location but not notifications gets a one-shot that
  // burns itself silently at the region and is gone. The prompt belongs here,
  // where they just asked for the reminder.
  const canNotify = await ensurePermission({ prompt: true });
  if (!canNotify.ok) return canNotify;

  const synced = await manager.syncRegions();
  if (!synced.ok) return synced;

  return ok({ watching: manager.monitoredIds().includes(triggerId), summary: synced.value });
}

/** Re-diffs the monitored set against the database. Cheap when nothing changed. */
export function refresh(): Promise<Result<SyncSummary>> {
  return manager.syncRegions();
}

export function status(): Promise<GeofenceStatus> {
  return manager.status();
}

/** Hands every region back to the OS; used when the user turns the feature off. */
export function stopAll(): Promise<Result<void>> {
  return manager.stopAll();
}

export function getGeofenceManager() {
  return manager;
}
