/**
 * Region registration and battery discipline.
 *
 * Every OS call arrives as an injected port. That is not ceremony: the two
 * decisions worth getting right — *which* twenty regions, and whether the set
 * changed at all — are only reachable in a test if no native module has to be
 * present to reach them.
 *
 * Re-arming an unchanged set is the expensive mistake. iOS tears down and
 * re-creates every region on each `startGeofencing` call, which loses the
 * crossing of a region the user is standing inside and wakes the location stack
 * for nothing, so this module diffs before it ever talks to the OS.
 */
import { now } from '@/core/clock';
import type { Logger } from '@/core/logger';
import { err, fail, ok, toAppError, type Result } from '@/core/result';
import type { GeofenceTrigger } from '@/db/schema';
import {
  MAX_MONITORED_REGIONS,
  selectRegionsToMonitor,
  shouldFire,
  type GeofencesRepository,
  type TriggerType,
} from '@/repositories/geofences';
import type { Coords } from '@/repositories/places';

export type GeofencePlatform = 'ios' | 'android' | 'web' | 'windows' | 'macos';

export type PermissionSnapshot = { granted: boolean; canAskAgain: boolean };

/** A region as the OS wants it; shaped to match expo-location's `LocationRegion`. */
export type MonitoredRegion = {
  identifier: string;
  latitude: number;
  longitude: number;
  radius: number;
  notifyOnEnter: boolean;
  notifyOnExit: boolean;
};

export type LocationPort = {
  /** False on web and anywhere the task runner is missing. */
  isAvailable(): Promise<boolean>;
  getForegroundPermission(): Promise<PermissionSnapshot>;
  requestForegroundPermission(): Promise<PermissionSnapshot>;
  getBackgroundPermission(): Promise<PermissionSnapshot>;
  requestBackgroundPermission(): Promise<PermissionSnapshot>;
  /** Cached fix only — this ranks regions, it never gates a reminder. */
  getLastKnownPosition(): Promise<Coords | null>;
  hasStartedGeofencing(): Promise<boolean>;
  startGeofencing(regions: MonitoredRegion[]): Promise<void>;
  /** Must tolerate being called when nothing is registered. */
  stopGeofencing(): Promise<void>;
  /** iOS only: significant-location-change, used purely as a wake-up. */
  hasStartedWakeUpdates?(): Promise<boolean>;
  startWakeUpdates?(): Promise<void>;
  stopWakeUpdates?(): Promise<void>;
};

export type PlaceNotification = {
  title: string;
  body: string;
  triggerId: string;
  taskId: string | null;
};

export type NotificationPort = {
  /** Presents on the 'places' channel; the channel id belongs to the adapter. */
  present(input: PlaceNotification): Promise<Result<string>>;
};

export type GeofenceManagerDeps = {
  /** A thunk so the manager can be built before the database is open. */
  geofences: () => GeofencesRepository;
  location: LocationPort;
  notifications: NotificationPort;
  platform: GeofencePlatform;
  /** Omitted in tests: pulling the real logger in would pull React Native in. */
  logger?: Logger;
};

export type GeofencePermission = {
  /** True only when crossings will still arrive with the app closed. */
  granted: boolean;
  foreground: boolean;
  background: boolean;
  canAskAgain: boolean;
  /**
   * The UI must say why "Always" / "Allow all the time" is needed before the
   * next ask. Also attached to the `details` of every permission error below,
   * so the caller can read it off either branch of the Result.
   */
  needsBackgroundExplanation: boolean;
  available: boolean;
};

export type SyncSummary = {
  /** Regions handed to the OS — never more than `MAX_MONITORED_REGIONS`. */
  monitored: number;
  /** Live triggers the user has, cap or no cap. */
  totalActive: number;
  capped: boolean;
  /** How many live triggers lost the cap and are not being watched. */
  dropped: number;
  /** False when the set already matched and the OS was left alone. */
  changed: boolean;
};

export type GeofenceStatus = {
  permission: GeofencePermission;
  monitored: number;
  capped: boolean;
  dropped: number;
  totalActive: number;
};

export type RegionEvent = {
  eventType: TriggerType;
  identifier: string | null | undefined;
  at?: number;
};

export type RegionEventReason = 'fired' | 'unknown-region' | 'wrong-direction' | 'suppressed';

export type RegionEventOutcome = {
  fired: boolean;
  reason: RegionEventReason;
  trigger: GeofenceTrigger | null;
  notificationId: string | null;
};

const UNAVAILABLE_MESSAGE = 'Location reminders are not available on this device.';
const FOREGROUND_DENIED_MESSAGE =
  'Ridik needs location access to remind you when you get somewhere.';
const BACKGROUND_DENIED_MESSAGE =
  'Ridik needs "Always" location access so place reminders still fire when the app is closed.';

const DENIED: PermissionSnapshot = { granted: false, canAskAgain: false };

/**
 * Mirrors the rule `listActiveTriggers` applies before it caps. The repository
 * caps at twenty on the way out, which hides the very number the user has to be
 * told about ("3 places aren't being watched"), so the count is recomputed here
 * from the unfiltered list.
 */
function isLive(trigger: GeofenceTrigger, at: number): boolean {
  if (!(trigger.isActive ?? true)) return false;
  if (trigger.expiresAt !== null && at >= trigger.expiresAt) return false;
  return !(trigger.oneShot && trigger.lastTriggeredAt !== null);
}

function toRegion(trigger: GeofenceTrigger): MonitoredRegion {
  return {
    identifier: trigger.id,
    latitude: trigger.latitude,
    longitude: trigger.longitude,
    radius: trigger.radiusMeters,
    // Only the direction that can actually fire is requested: the opposite
    // crossing would wake the app just to be thrown away.
    notifyOnEnter: trigger.triggerType === 'ENTER',
    notifyOnExit: trigger.triggerType === 'EXIT',
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((id) => seen.has(id));
}

function describePermission(
  available: boolean,
  foreground: PermissionSnapshot,
  background: PermissionSnapshot,
): GeofencePermission {
  return {
    available,
    foreground: foreground.granted,
    background: background.granted,
    granted: available && foreground.granted && background.granted,
    canAskAgain: foreground.granted ? background.canAskAgain : foreground.canAskAgain,
    // Android 10+ puts "Allow all the time" behind a second prompt that only
    // makes sense once the user has been told what it buys them; iOS shows the
    // same escalation once when-in-use is already granted.
    needsBackgroundExplanation: available && foreground.granted && !background.granted,
  };
}

const unavailablePermission = (): GeofencePermission => describePermission(false, DENIED, DENIED);

export function createGeofenceManager(deps: GeofenceManagerDeps) {
  const log = deps.logger;

  // What this process last handed the OS. `null` means "not synced yet in this
  // process", which after a cold start is a different thing from "nothing is
  // registered" — the OS may well still be holding regions.
  let monitored: string[] | null = null;

  async function readPermission(): Promise<GeofencePermission> {
    try {
      if (!(await deps.location.isAvailable())) return unavailablePermission();
      const foreground = await deps.location.getForegroundPermission();
      const background = foreground.granted
        ? await deps.location.getBackgroundPermission()
        : DENIED;
      return describePermission(true, foreground, background);
    } catch (error) {
      log?.warn('could not read location permission', error);
      return unavailablePermission();
    }
  }

  /**
   * Asks, in the order the platforms allow: foreground first, then background.
   * A refusal is a normal outcome, so it comes back as an error Result whose
   * `details` is the `GeofencePermission` the UI needs to explain itself.
   */
  async function ensurePermissions(): Promise<Result<GeofencePermission>> {
    try {
      if (!(await deps.location.isAvailable())) {
        return fail('unsupported', UNAVAILABLE_MESSAGE, { details: unavailablePermission() });
      }

      let foreground = await deps.location.getForegroundPermission();
      if (!foreground.granted && foreground.canAskAgain) {
        foreground = await deps.location.requestForegroundPermission();
      }
      if (!foreground.granted) {
        return fail('permission_denied', FOREGROUND_DENIED_MESSAGE, {
          details: describePermission(true, foreground, DENIED),
        });
      }

      // Neither OS will grant background access in the same breath as
      // foreground: iOS only offers "Always" once when-in-use is held, and
      // Android 10+ made it a separate permission entirely.
      let background = await deps.location.getBackgroundPermission();
      if (!background.granted && background.canAskAgain) {
        background = await deps.location.requestBackgroundPermission();
      }

      const permission = describePermission(true, foreground, background);
      if (!permission.granted) {
        return fail('permission_denied', BACKGROUND_DENIED_MESSAGE, { details: permission });
      }
      return ok(permission);
    } catch (error) {
      return err(toAppError(error, 'Could not check location permission.'));
    }
  }

  async function currentLocation(): Promise<Coords | undefined> {
    try {
      return (await deps.location.getLastKnownPosition()) ?? undefined;
    } catch (error) {
      log?.debug('no cached position', error);
      return undefined;
    }
  }

  /**
   * After a cold start the only record of what the OS is holding is the
   * `registered` flag, and it is only worth believing while the OS agrees the
   * task is still running — Android drops every region on reboot.
   */
  async function registeredWithOs(all: readonly GeofenceTrigger[]): Promise<string[]> {
    const started = await deps.location.hasStartedGeofencing().catch(() => false);
    if (!started) return [];
    return all.filter((trigger) => trigger.registered).map((trigger) => trigger.id);
  }

  /**
   * The twenty regions we picked are only the right twenty near wherever the
   * user was when we picked them. Significant-location-change is the cheap way
   * to notice they have moved on — the radio reports cell handovers anyway —
   * where continuous updates would keep the location stack awake all day.
   * Android needs none of this: its geofences are not capped by proximity.
   */
  async function syncWake(wanted: boolean): Promise<void> {
    if (deps.platform !== 'ios') return;
    const { location } = deps;
    try {
      const running = location.hasStartedWakeUpdates
        ? await location.hasStartedWakeUpdates()
        : !wanted;
      if (wanted && !running) await location.startWakeUpdates?.();
      else if (!wanted && running) await location.stopWakeUpdates?.();
    } catch (error) {
      // Losing the wake channel costs freshness, not correctness: the regions
      // the OS already holds keep firing.
      log?.warn('wake monitoring unavailable', error);
    }
  }

  /**
   * Brings the OS in line with the database. Calls into the OS only when the
   * chosen set actually differs from what is already registered.
   */
  async function runSync(): Promise<Result<SyncSummary>> {
    try {
      const at = now();
      const permission = await readPermission();
      if (!permission.available) {
        return fail('unsupported', UNAVAILABLE_MESSAGE, { details: permission });
      }
      if (!permission.foreground) {
        return fail('permission_denied', FOREGROUND_DENIED_MESSAGE, { details: permission });
      }

      const repository = deps.geofences();
      const all = await repository.listAllTriggers();
      const live = all.filter((trigger) => isLive(trigger, at));
      const selected = selectRegionsToMonitor(live, await currentLocation());
      const desired = selected.map((trigger) => trigger.id);

      // Keyed by trigger id alone: the data layer never edits a trigger's
      // coordinates, radius or direction, so two syncs that agree on ids agree
      // on geometry — and ids are all the database remembers about what the OS
      // is holding once the process has been killed.
      const current = monitored ?? (await registeredWithOs(all));
      const changed = !sameSet(current, desired);

      if (changed) {
        if (desired.length === 0) await deps.location.stopGeofencing();
        else await deps.location.startGeofencing(selected.map(toRegion));

        await repository.clearRegistered();
        if (desired.length > 0) await repository.markRegistered(desired);
        log?.info('regions synced', { monitored: desired.length, live: live.length });
      }

      // Recorded on both branches, and only once the writes above have gone
      // through. Leaving it null after an unchanged sync would keep re-deriving
      // "what the OS holds" from the `registered` flags — flags that
      // `recordTrigger` clears behind our back when a one-shot burns itself, so
      // the next diff would agree with a set the OS is no longer holding and
      // the spent region would stay armed for good.
      monitored = desired;

      await syncWake(desired.length > 0);

      return ok({
        monitored: desired.length,
        totalActive: live.length,
        capped: live.length > desired.length,
        dropped: live.length - desired.length,
        changed,
      });
    } catch (error) {
      log?.error('region sync failed', error);
      return fail('unknown', 'Could not update your place reminders.', { cause: error });
    }
  }

  // Startup, the iOS wake task, the voice pipeline and a one-shot burning
  // itself can all ask for a sync at the same time. Overlapping runs would both
  // read the pre-sync `monitored`, both conclude the set changed and both call
  // `startGeofencing` — the double re-arm this whole module exists to avoid —
  // and their `clearRegistered`/`markRegistered` pairs could interleave into a
  // table that claims a set the OS is not holding. So runs are queued.
  let queue: Promise<unknown> = Promise.resolve();

  function syncRegions(): Promise<Result<SyncSummary>> {
    const run = queue.then(runSync, runSync);
    queue = run.catch(() => undefined);
    return run;
  }

  /**
   * One region crossing, start to finish: is it ours, is it the right
   * direction, is it allowed to fire, tell the user, burn it if it was
   * one-shot. Called from the background task, so it never throws.
   */
  async function handleRegionEvent(event: RegionEvent): Promise<Result<RegionEventOutcome>> {
    try {
      const at = event.at ?? now();
      const identifier = event.identifier?.trim();
      if (!identifier) {
        return ok({ fired: false, reason: 'unknown-region', trigger: null, notificationId: null });
      }

      const repository = deps.geofences();
      const trigger = await repository.getTrigger(identifier);
      if (!trigger) {
        // The OS is holding a region the database can no longer explain; a sync
        // is what actually takes it back off the OS.
        log?.warn('crossing for an unknown region', { identifier });
        await syncRegions();
        return ok({ fired: false, reason: 'unknown-region', trigger: null, notificationId: null });
      }

      // Android delivers both directions for a region it is watching, so the
      // direction filter cannot live only in the registration.
      if (trigger.triggerType !== event.eventType) {
        return ok({ fired: false, reason: 'wrong-direction', trigger, notificationId: null });
      }
      if (!shouldFire(trigger, at)) {
        return ok({ fired: false, reason: 'suppressed', trigger, notificationId: null });
      }

      const recorded = await repository.recordTrigger(trigger.id, at);
      if (!recorded.ok) return recorded;
      if (!recorded.value.fired) {
        return ok({
          fired: false,
          reason: 'suppressed',
          trigger: recorded.value.trigger,
          notificationId: null,
        });
      }

      const fired = recorded.value.trigger;
      const presented = await deps.notifications.present({
        title: fired.actionDescription,
        body:
          fired.triggerType === 'ENTER'
            ? `You're at ${fired.label}.`
            : `You've left ${fired.label}.`,
        triggerId: fired.id,
        taskId: fired.taskId,
      });
      if (!presented.ok) log?.error('could not present place reminder', presented.error.userMessage);

      if (fired.oneShot) {
        // `recordTrigger` already flipped it inactive and unregistered; the OS
        // goes on holding the region until the set is diffed again.
        await syncRegions();
      }

      return ok({
        fired: true,
        reason: 'fired',
        trigger: fired,
        notificationId: presented.ok ? presented.value : null,
      });
    } catch (error) {
      log?.error('region event failed', error);
      return fail('unknown', 'Could not handle that place reminder.', { cause: error });
    }
  }

  /**
   * Boot and app start. Forgets what this process thought it registered: after
   * a reboot Android has dropped every region and iOS has kept them, and only
   * the OS can say which — `syncRegions` asks before it re-arms anything.
   */
  async function resumeAfterRestart(): Promise<Result<SyncSummary>> {
    monitored = null;
    return syncRegions();
  }

  async function stopAll(): Promise<Result<void>> {
    try {
      await deps.location.stopGeofencing();
      await syncWake(false);
      await deps.geofences().clearRegistered();
      monitored = [];
      return ok(undefined);
    } catch (error) {
      log?.error('could not stop geofencing', error);
      return fail('unknown', 'Could not turn off place reminders.', { cause: error });
    }
  }

  async function status(): Promise<GeofenceStatus> {
    const permission = await readPermission();
    try {
      const at = now();
      const all = await deps.geofences().listAllTriggers();
      const live = all.filter((trigger) => isLive(trigger, at));
      const watched = monitored ?? (await registeredWithOs(all));
      return {
        permission,
        monitored: watched.length,
        totalActive: live.length,
        // Only the cap can drop a live trigger. Everything else that leaves the
        // set short — no permission yet, the feature switched off — is not the
        // twenty-region limit, and a screen that says so is lying.
        capped: watched.length >= MAX_MONITORED_REGIONS && live.length > watched.length,
        dropped: Math.max(0, live.length - watched.length),
      };
    } catch (error) {
      // The only method here that does not return a Result, and the one a
      // screen renders from: a database that is not open yet has to read as
      // "nothing watched", never as a throw through a render.
      log?.warn('could not read geofence status', error);
      return { permission, monitored: 0, totalActive: 0, capped: false, dropped: 0 };
    }
  }

  /** What this process last handed the OS; empty until the first sync. */
  function monitoredIds(): readonly string[] {
    return monitored ?? [];
  }

  return {
    ensurePermissions,
    readPermission,
    syncRegions,
    handleRegionEvent,
    resumeAfterRestart,
    stopAll,
    status,
    monitoredIds,
  };
}

export type GeofenceManager = ReturnType<typeof createGeofenceManager>;

export { MAX_MONITORED_REGIONS };

let active: GeofenceManager | null = null;

/**
 * The background task is entered with no React tree and must not import the
 * facade — that would drag every native module into the task's graph before the
 * OS has even said why it woke us. The facade puts the live manager here
 * instead, and the task looks it up.
 */
export function setActiveGeofenceManager(manager: GeofenceManager | null): void {
  active = manager;
}

export function getActiveGeofenceManager(): GeofenceManager | null {
  return active;
}
