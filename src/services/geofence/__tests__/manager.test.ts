import { freezeClock } from '@/core/clock';
import { ok, type Result } from '@/core/result';
import type { RidikDatabase } from '@/db/migrator';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import {
  createGeofencesRepository,
  MAX_MONITORED_REGIONS,
  type CreateTriggerInput,
  type GeofencesRepository,
} from '@/repositories/geofences';
import type { Coords } from '@/repositories/places';
import {
  createGeofenceManager,
  type GeofenceManager,
  type GeofencePlatform,
  type LocationPort,
  type MonitoredRegion,
  type NotificationPort,
  type PermissionSnapshot,
  type PlaceNotification,
} from '@/services/geofence/manager';

const NOW = 1_772_000_000_000;
const MINUTE = 60_000;
const SOFIA: Coords = { latitude: 42.6977, longitude: 23.3219 };

const GRANTED: PermissionSnapshot = { granted: true, canAskAgain: false };
const REFUSABLE: PermissionSnapshot = { granted: false, canAskAgain: true };
const REFUSED: PermissionSnapshot = { granted: false, canAskAgain: false };

type FakeLocation = {
  port: LocationPort;
  /** Every OS-facing call, in order, so "did not touch the OS" is assertable. */
  calls: string[];
  regions: MonitoredRegion[];
  started: boolean;
  wakeRunning: boolean;
  available: boolean;
  foreground: PermissionSnapshot;
  background: PermissionSnapshot;
  position: Coords | null;
  startError: Error | null;
  requests: string[];
  /** What the system prompt answers, when the manager gets as far as showing it. */
  foregroundOnRequest: PermissionSnapshot | null;
  backgroundOnRequest: PermissionSnapshot | null;
};

function createFakeLocation(): FakeLocation {
  const state: FakeLocation = {
    port: null as unknown as LocationPort,
    calls: [],
    regions: [],
    started: false,
    wakeRunning: false,
    available: true,
    foreground: GRANTED,
    background: GRANTED,
    position: null,
    startError: null,
    requests: [],
    foregroundOnRequest: null,
    backgroundOnRequest: null,
  };

  state.port = {
    isAvailable: async () => state.available,
    getForegroundPermission: async () => state.foreground,
    requestForegroundPermission: async () => {
      state.requests.push('foreground');
      if (state.foregroundOnRequest) state.foreground = state.foregroundOnRequest;
      return state.foreground;
    },
    getBackgroundPermission: async () => state.background,
    requestBackgroundPermission: async () => {
      state.requests.push('background');
      if (state.backgroundOnRequest) state.background = state.backgroundOnRequest;
      return state.background;
    },
    getLastKnownPosition: async () => state.position,
    hasStartedGeofencing: async () => state.started,
    startGeofencing: async (regions) => {
      state.calls.push('start');
      if (state.startError) throw state.startError;
      state.regions = regions;
      state.started = true;
    },
    stopGeofencing: async () => {
      state.calls.push('stop');
      state.regions = [];
      state.started = false;
    },
    hasStartedWakeUpdates: async () => state.wakeRunning,
    startWakeUpdates: async () => {
      state.calls.push('wake:start');
      state.wakeRunning = true;
    },
    stopWakeUpdates: async () => {
      state.calls.push('wake:stop');
      state.wakeRunning = false;
    },
  };

  return state;
}

function createFakeNotifications(): { port: NotificationPort; sent: PlaceNotification[] } {
  const sent: PlaceNotification[] = [];
  return {
    sent,
    port: {
      present: async (input): Promise<Result<string>> => {
        sent.push(input);
        return ok(`notification-${sent.length}`);
      },
    },
  };
}

describe('geofence manager', () => {
  let test: TestDatabase;
  let db: RidikDatabase;
  let geofences: GeofencesRepository;
  let location: FakeLocation;
  let notifications: ReturnType<typeof createFakeNotifications>;
  let restoreClock: () => void;

  function build(platform: GeofencePlatform = 'android'): GeofenceManager {
    return createGeofenceManager({
      geofences: () => geofences,
      location: location.port,
      notifications: notifications.port,
      platform,
    });
  }

  function makeTrigger(overrides: Partial<CreateTriggerInput> = {}) {
    return geofences.createTrigger({
      label: 'The Lab',
      actionDescription: 'Grab the soldering iron',
      triggerType: 'ENTER',
      latitude: SOFIA.latitude,
      longitude: SOFIA.longitude,
      ...overrides,
    });
  }

  beforeEach(() => {
    restoreClock = freezeClock(NOW);
    test = createTestDatabase();
    db = test.db;
    geofences = createGeofencesRepository(db);
    location = createFakeLocation();
    notifications = createFakeNotifications();
  });

  afterEach(() => {
    test.close();
    restoreClock();
  });

  describe('syncRegions', () => {
    it('registers the live set once and leaves the OS alone when nothing changed', async () => {
      const manager = build();
      await makeTrigger({ label: 'Lab' });
      await makeTrigger({ label: 'Pharmacy', triggerType: 'EXIT' });

      const first = await manager.syncRegions();
      expect(first.ok && first.value).toMatchObject({
        monitored: 2,
        totalActive: 2,
        capped: false,
        dropped: 0,
        changed: true,
      });
      expect(location.calls).toEqual(['start']);
      expect(location.regions.map((r) => r.identifier).sort()).toEqual(
        (await geofences.listAllTriggers()).map((t) => t.id).sort(),
      );

      const second = await manager.syncRegions();
      expect(second.ok && second.value.changed).toBe(false);
      expect(location.calls).toEqual(['start']);
    });

    it('re-registers as soon as the set actually differs', async () => {
      const manager = build();
      await makeTrigger({ label: 'Lab' });
      await manager.syncRegions();

      await makeTrigger({ label: 'Pharmacy' });
      const grown = await manager.syncRegions();

      expect(grown.ok && grown.value.changed).toBe(true);
      expect(location.calls).toEqual(['start', 'start']);
      expect(location.regions).toHaveLength(2);
    });

    it('registers only the direction each trigger can fire in', async () => {
      const manager = build();
      await makeTrigger({ label: 'Lab', triggerType: 'ENTER' });
      await makeTrigger({ label: 'Office', triggerType: 'EXIT' });
      await manager.syncRegions();

      const byEnter = location.regions.filter((r) => r.notifyOnEnter);
      const byExit = location.regions.filter((r) => r.notifyOnExit);
      expect(byEnter).toHaveLength(1);
      expect(byExit).toHaveLength(1);
      expect(byEnter[0]!.notifyOnExit).toBe(false);
    });

    it('stops geofencing when the last region goes away', async () => {
      const manager = build();
      const trigger = await makeTrigger();
      await manager.syncRegions();

      await geofences.deactivateTrigger(trigger.id);
      const emptied = await manager.syncRegions();

      expect(emptied.ok && emptied.value).toMatchObject({ monitored: 0, changed: true });
      expect(location.calls).toEqual(['start', 'stop']);
      expect(location.started).toBe(false);
    });

    it('marks exactly the registered ids in the database', async () => {
      const manager = build();
      const kept = await makeTrigger({ label: 'Lab' });
      const dropped = await makeTrigger({ label: 'Gone' });
      await manager.syncRegions();
      await geofences.deactivateTrigger(dropped.id);
      await manager.syncRegions();

      const rows = await geofences.listAllTriggers();
      expect(rows.find((t) => t.id === kept.id)!.registered).toBe(true);
      expect(rows.find((t) => t.id === dropped.id)!.registered).toBe(false);
    });

    it('caps at the OS limit and reports how many were dropped', async () => {
      const manager = build();
      for (let i = 0; i < MAX_MONITORED_REGIONS + 5; i += 1) {
        await makeTrigger({ label: `Place ${i}` });
      }

      const synced = await manager.syncRegions();

      expect(synced.ok && synced.value).toMatchObject({
        monitored: MAX_MONITORED_REGIONS,
        totalActive: MAX_MONITORED_REGIONS + 5,
        capped: true,
        dropped: 5,
      });
      expect(location.regions).toHaveLength(MAX_MONITORED_REGIONS);
    });

    it('spends the cap on the nearest regions when a cached fix is available', async () => {
      const manager = build();
      location.position = SOFIA;
      for (let i = 0; i < MAX_MONITORED_REGIONS; i += 1) {
        await makeTrigger({ label: `Far ${i}`, latitude: 40 + i * 0.5, longitude: 20 });
      }
      const near = await makeTrigger({ label: 'Near', ...SOFIA });

      await manager.syncRegions();

      expect(location.regions.map((r) => r.identifier)).toContain(near.id);
      expect(location.regions).toHaveLength(MAX_MONITORED_REGIONS);
    });

    it('ignores expired and spent triggers when counting what is live', async () => {
      const manager = build();
      await makeTrigger({ label: 'Live' });
      await makeTrigger({ label: 'Expired', expiresAt: NOW - MINUTE });
      const spent = await makeTrigger({ label: 'Spent', oneShot: true });
      await geofences.recordTrigger(spent.id, NOW - MINUTE);

      const synced = await manager.syncRegions();

      expect(synced.ok && synced.value).toMatchObject({ monitored: 1, totalActive: 1 });
    });

    it('names the missing background permission instead of letting the OS reject the call', async () => {
      // Where every Android user who answers "While using the app" ends up:
      // foreground is held, background is not, and the platform refuses to arm
      // anything. Reported as `unknown` it reads as a bug in Ridik; reported
      // honestly it tells the user which switch to flip.
      const manager = build();
      location.foreground = GRANTED;
      location.background = REFUSABLE;
      await makeTrigger({ label: 'Lab' });

      const synced = await manager.syncRegions();

      expect(synced.ok).toBe(false);
      expect(!synced.ok && synced.error.code).toBe('permission_denied');
      expect(!synced.ok && synced.error.message).toMatch(/Always/);
      // And it never reached the OS, so there is nothing half-armed behind it.
      expect(location.calls).not.toContain('start');
      expect((await geofences.listAllTriggers()).every((t) => !t.registered)).toBe(true);
    });

    it('still releases regions when background access is gone', async () => {
      // Revoking "Always" must not strand the regions the OS is already
      // holding: dropping them needs no permission, so the gate above may not
      // stand in the way of the cleanup.
      const manager = build();
      const trigger = await makeTrigger({ label: 'Lab' });
      await manager.syncRegions();
      expect(location.started).toBe(true);

      location.background = REFUSED;
      await geofences.deactivateTrigger(trigger.id);
      const synced = await manager.syncRegions();

      expect(synced.ok && synced.value.monitored).toBe(0);
      expect(location.calls).toContain('stop');
    });

    it('remembers the set even when the OS was already holding it', async () => {
      const trigger = await makeTrigger();
      await build().syncRegions();

      // Cold start onto an OS that is already armed: the diff finds nothing to
      // do, but this process still knows what is being watched.
      const fresh = build();
      const synced = await fresh.syncRegions();

      expect(synced.ok && synced.value.changed).toBe(false);
      expect(fresh.monitoredIds()).toEqual([trigger.id]);
    });

    it('hands back a spent one-shot after a sync that changed nothing', async () => {
      const spent = await makeTrigger({ label: 'Once', oneShot: true });
      const keeper = await makeTrigger({ label: 'Always', oneShot: false });
      await build().syncRegions();

      // Cold start, OS already armed with both, so this sync is a no-op...
      const fresh = build();
      await fresh.syncRegions();
      location.calls.length = 0;

      // ...and then the one-shot burns itself. `recordTrigger` clears its
      // `registered` flag, so a diff that re-derived "what the OS holds" from
      // those flags would agree with itself and leave the region armed forever.
      await fresh.handleRegionEvent({ eventType: 'ENTER', identifier: spent.id });

      expect(location.calls).toEqual(['start']);
      expect(location.regions.map((r) => r.identifier)).toEqual([keeper.id]);
      expect(fresh.monitoredIds()).toEqual([keeper.id]);
    });

    it('serialises overlapping syncs into a single re-arm', async () => {
      const manager = build();
      await makeTrigger();

      const [first, second] = await Promise.all([manager.syncRegions(), manager.syncRegions()]);

      // The second run must see what the first one registered, not the empty
      // set both would have read had they interleaved.
      expect(first.ok && first.value.changed).toBe(true);
      expect(second.ok && second.value.changed).toBe(false);
      expect(location.calls).toEqual(['start']);
    });

    it('turns a native failure into a Result instead of throwing', async () => {
      const manager = build();
      await makeTrigger();
      location.startError = new Error('CLLocationManager exploded');

      const synced = await manager.syncRegions();

      expect(synced.ok).toBe(false);
      expect(!synced.ok && synced.error.code).toBe('unknown');
      // Nothing was recorded as registered, so the next sync will try again.
      expect((await geofences.listAllTriggers()).every((t) => !t.registered)).toBe(true);
    });
  });

  describe('permissions', () => {
    it('asks for foreground first, then background', async () => {
      const manager = build();
      location.foreground = REFUSABLE;
      location.foregroundOnRequest = GRANTED;
      location.background = REFUSABLE;
      location.backgroundOnRequest = GRANTED;

      const permission = await manager.ensurePermissions();

      expect(location.requests).toEqual(['foreground', 'background']);
      expect(permission.ok && permission.value).toMatchObject({
        granted: true,
        needsBackgroundExplanation: false,
      });
    });

    it('never asks for background access the user has not unlocked yet', async () => {
      const manager = build();
      location.foreground = REFUSABLE;
      location.foregroundOnRequest = REFUSED;
      location.background = REFUSABLE;

      const permission = await manager.ensurePermissions();

      expect(location.requests).toEqual(['foreground']);
      expect(!permission.ok && permission.error.code).toBe('permission_denied');
    });

    it('flags the explanation when the background prompt itself is refused', async () => {
      const manager = build();
      location.background = REFUSABLE;
      location.backgroundOnRequest = REFUSED;

      const permission = await manager.ensurePermissions();

      expect(location.requests).toEqual(['background']);
      expect(!permission.ok && permission.error.details).toMatchObject({
        needsBackgroundExplanation: true,
      });
    });

    it('returns a clean Result when foreground access is refused', async () => {
      const manager = build();
      location.foreground = REFUSED;

      const permission = await manager.ensurePermissions();

      expect(permission.ok).toBe(false);
      expect(!permission.ok && permission.error.code).toBe('permission_denied');
      expect(!permission.ok && permission.error.userMessage).toMatch(/location access/i);
      // Refused for good: nothing was asked, and the background prompt never ran.
      expect(location.requests).toEqual([]);
    });

    it('flags that background access needs explaining when only foreground is held', async () => {
      const manager = build();
      location.foreground = GRANTED;
      location.background = REFUSED;

      const permission = await manager.ensurePermissions();

      expect(permission.ok).toBe(false);
      expect(!permission.ok && permission.error.code).toBe('permission_denied');
      expect(!permission.ok && permission.error.details).toMatchObject({
        foreground: true,
        background: false,
        granted: false,
        needsBackgroundExplanation: true,
      });
    });

    it('reports an unsupported platform rather than pretending', async () => {
      const manager = build('web');
      location.available = false;

      const permission = await manager.ensurePermissions();
      const synced = await manager.syncRegions();

      expect(!permission.ok && permission.error.code).toBe('unsupported');
      expect(!synced.ok && synced.error.code).toBe('unsupported');
      expect(location.calls).toEqual([]);
    });

    it('refuses to sync without foreground permission and leaves the OS untouched', async () => {
      const manager = build();
      await makeTrigger();
      location.foreground = REFUSED;

      const synced = await manager.syncRegions();

      expect(!synced.ok && synced.error.code).toBe('permission_denied');
      expect(location.calls).toEqual([]);
    });
  });

  describe('handleRegionEvent', () => {
    it('notifies and burns a one-shot, then takes the region off the OS', async () => {
      const manager = build();
      const trigger = await makeTrigger({ label: 'The Lab', oneShot: true });
      await manager.syncRegions();
      expect(location.regions).toHaveLength(1);

      const outcome = await manager.handleRegionEvent({
        eventType: 'ENTER',
        identifier: trigger.id,
      });

      expect(outcome.ok && outcome.value.fired).toBe(true);
      expect(notifications.sent).toEqual([
        {
          title: 'Grab the soldering iron',
          body: "You're at The Lab.",
          triggerId: trigger.id,
          taskId: null,
        },
      ]);

      const stored = await geofences.getTrigger(trigger.id);
      expect(stored).toMatchObject({ isActive: false, registered: false, lastTriggeredAt: NOW });
      // The spent region was handed straight back to the OS.
      expect(location.calls).toEqual(['start', 'stop']);
      expect(location.started).toBe(false);
      expect(manager.monitoredIds()).toEqual([]);
    });

    it('keeps a repeating trigger registered after it fires', async () => {
      const manager = build();
      const trigger = await makeTrigger({ oneShot: false, cooldownSeconds: 900 });
      await manager.syncRegions();

      await manager.handleRegionEvent({ eventType: 'ENTER', identifier: trigger.id });

      expect(location.calls).toEqual(['start']);
      expect(manager.monitoredIds()).toEqual([trigger.id]);
    });

    it('suppresses a crossing inside the cooldown window', async () => {
      const manager = build();
      const trigger = await makeTrigger({ oneShot: false, cooldownSeconds: 900 });
      await manager.handleRegionEvent({ eventType: 'ENTER', identifier: trigger.id });

      const again = await manager.handleRegionEvent({
        eventType: 'ENTER',
        identifier: trigger.id,
        at: NOW + 14 * MINUTE,
      });

      expect(again.ok && again.value).toMatchObject({ fired: false, reason: 'suppressed' });
      expect(notifications.sent).toHaveLength(1);

      const afterCooldown = await manager.handleRegionEvent({
        eventType: 'ENTER',
        identifier: trigger.id,
        at: NOW + 15 * MINUTE,
      });
      expect(afterCooldown.ok && afterCooldown.value.fired).toBe(true);
      expect(notifications.sent).toHaveLength(2);
    });

    it('ignores a crossing in the direction the trigger does not watch', async () => {
      const manager = build();
      const trigger = await makeTrigger({ triggerType: 'ENTER' });

      const outcome = await manager.handleRegionEvent({
        eventType: 'EXIT',
        identifier: trigger.id,
      });

      expect(outcome.ok && outcome.value).toMatchObject({ fired: false, reason: 'wrong-direction' });
      expect(notifications.sent).toEqual([]);
      expect((await geofences.getTrigger(trigger.id))!.lastTriggeredAt).toBeNull();
    });

    it('says "you left" for an EXIT trigger', async () => {
      const manager = build();
      const trigger = await makeTrigger({ label: 'The Office', triggerType: 'EXIT' });

      await manager.handleRegionEvent({ eventType: 'EXIT', identifier: trigger.id });

      expect(notifications.sent[0]!.body).toBe("You've left The Office.");
    });

    it('resyncs a region the database can no longer explain', async () => {
      const manager = build();
      const ghost = await makeTrigger();
      await manager.syncRegions();
      await geofences.deleteTrigger(ghost.id);

      const outcome = await manager.handleRegionEvent({ eventType: 'ENTER', identifier: ghost.id });

      expect(outcome.ok && outcome.value.reason).toBe('unknown-region');
      expect(location.calls).toEqual(['start', 'stop']);
      expect(notifications.sent).toEqual([]);
    });

    it('never fires on an empty identifier', async () => {
      const manager = build();
      const outcome = await manager.handleRegionEvent({ eventType: 'ENTER', identifier: null });
      expect(outcome.ok && outcome.value).toMatchObject({ fired: false, reason: 'unknown-region' });
      expect(location.calls).toEqual([]);
    });
  });

  describe('resumeAfterRestart', () => {
    it('re-arms regions the OS lost across a reboot', async () => {
      const trigger = await makeTrigger();
      await build().syncRegions();
      // A reboot: the row still claims it is registered, the OS disagrees.
      location.started = false;
      location.regions = [];

      const fresh = build();
      const resumed = await fresh.resumeAfterRestart();

      expect(resumed.ok && resumed.value.changed).toBe(true);
      expect(location.regions.map((r) => r.identifier)).toEqual([trigger.id]);
    });

    it('leaves an already-armed OS alone', async () => {
      await makeTrigger();
      await build().syncRegions();
      location.calls.length = 0;

      const fresh = build();
      const resumed = await fresh.resumeAfterRestart();

      expect(resumed.ok && resumed.value.changed).toBe(false);
      expect(location.calls).toEqual([]);
    });
  });

  describe('iOS wake monitoring', () => {
    it('starts significant-location-change alongside the regions', async () => {
      const manager = build('ios');
      await makeTrigger();

      await manager.syncRegions();
      expect(location.calls).toEqual(['start', 'wake:start']);
      expect(location.wakeRunning).toBe(true);

      // Already running: a second sync must not restart it.
      await manager.syncRegions();
      expect(location.calls).toEqual(['start', 'wake:start']);
    });

    it('stops the wake channel once nothing is monitored', async () => {
      const manager = build('ios');
      const trigger = await makeTrigger();
      await manager.syncRegions();
      await geofences.deactivateTrigger(trigger.id);

      await manager.syncRegions();

      expect(location.calls).toEqual(['start', 'wake:start', 'stop', 'wake:stop']);
      expect(location.wakeRunning).toBe(false);
    });

    it('is an iOS-only cost', async () => {
      const manager = build('android');
      await makeTrigger();
      await manager.syncRegions();
      expect(location.calls).toEqual(['start']);
      expect(location.wakeRunning).toBe(false);
    });
  });

  describe('status and stopAll', () => {
    it('reports permission, what is watched and what was dropped', async () => {
      const manager = build();
      for (let i = 0; i < MAX_MONITORED_REGIONS + 2; i += 1) {
        await makeTrigger({ label: `Place ${i}` });
      }
      await manager.syncRegions();

      expect(await manager.status()).toMatchObject({
        monitored: MAX_MONITORED_REGIONS,
        totalActive: MAX_MONITORED_REGIONS + 2,
        capped: true,
        dropped: 2,
        permission: { granted: true, foreground: true, background: true },
      });
    });

    it('reads what the OS is holding when this process has not synced yet', async () => {
      await makeTrigger();
      await build().syncRegions();

      const fresh = build();
      expect(await fresh.status()).toMatchObject({ monitored: 1, capped: false });
    });

    it('does not blame the cap for a set that is short for another reason', async () => {
      const manager = build();
      await makeTrigger();
      await manager.syncRegions();
      await manager.stopAll();

      // Nothing is watched, but not because twenty was not enough.
      expect(await manager.status()).toMatchObject({ monitored: 0, totalActive: 1, capped: false });
    });

    it('reports an empty status instead of throwing when the database is gone', async () => {
      const manager = build();
      await makeTrigger();
      geofences = {
        listAllTriggers: () => Promise.reject(new Error('database is not open')),
      } as unknown as GeofencesRepository;

      // A screen renders straight off this; it is the one method with no Result
      // to hide behind.
      await expect(manager.status()).resolves.toMatchObject({
        monitored: 0,
        totalActive: 0,
        capped: false,
        permission: { granted: true },
      });
    });

    it('hands everything back on stopAll', async () => {
      const manager = build('ios');
      await makeTrigger();
      await manager.syncRegions();

      const stopped = await manager.stopAll();

      expect(stopped.ok).toBe(true);
      expect(location.started).toBe(false);
      expect(location.wakeRunning).toBe(false);
      expect((await geofences.listAllTriggers()).every((t) => !t.registered)).toBe(true);
      expect(manager.monitoredIds()).toEqual([]);
    });
  });
});
