/**
 * The OS-facing shim. Two things matter here and neither is reachable from the
 * manager's tests: importing this file where `expo-task-manager` is not a real
 * native module must be a no-op, and neither task body may ever reject — the OS
 * enters them with no React tree and nothing to catch a rejection.
 */
import { fail, ok, type Result } from '@/core/result';
import {
  setActiveGeofenceManager,
  type GeofenceManager,
  type RegionEvent,
  type RegionEventOutcome,
  type SyncSummary,
} from '@/services/geofence/manager';
import {
  GEOFENCE_TASK,
  GEOFENCE_WAKE_TASK,
  registerGeofenceTasks,
  runGeofenceTask,
  runWakeTask,
} from '@/services/geofence/task';

type FakeManager = {
  manager: GeofenceManager;
  events: RegionEvent[];
  syncs: number;
};

const OUTCOME: RegionEventOutcome = {
  fired: true,
  reason: 'fired',
  trigger: null,
  notificationId: 'notification-1',
};

const SUMMARY: SyncSummary = {
  monitored: 1,
  totalActive: 1,
  capped: false,
  dropped: 0,
  changed: true,
};

function createFakeManager(
  overrides: Partial<{
    handleRegionEvent: (event: RegionEvent) => Promise<Result<RegionEventOutcome>>;
    syncRegions: () => Promise<Result<SyncSummary>>;
  }> = {},
): FakeManager {
  const state: FakeManager = { manager: null as unknown as GeofenceManager, events: [], syncs: 0 };
  state.manager = {
    handleRegionEvent: async (event: RegionEvent) => {
      state.events.push(event);
      return overrides.handleRegionEvent ? overrides.handleRegionEvent(event) : ok(OUTCOME);
    },
    syncRegions: async () => {
      state.syncs += 1;
      return overrides.syncRegions ? overrides.syncRegions() : ok(SUMMARY);
    },
  } as unknown as GeofenceManager;
  return state;
}

describe('geofence task', () => {
  let errors: jest.SpyInstance;
  let warns: jest.SpyInstance;
  let logs: jest.SpyInstance;

  beforeEach(() => {
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    warns = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logs = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    setActiveGeofenceManager(null);
    errors.mockRestore();
    warns.mockRestore();
    logs.mockRestore();
  });

  it('keeps the task names stable — the OS remembers them across installs', () => {
    expect(GEOFENCE_TASK).toBe('ridik.geofence.regions');
    expect(GEOFENCE_WAKE_TASK).toBe('ridik.geofence.wake');
  });

  it('defines nothing, and throws nothing, where the native runner is absent', () => {
    // Importing this module already called it once at module scope; that it got
    // this far is the assertion.
    expect(registerGeofenceTasks()).toBe(false);
  });

  it('translates the OS event codes into a direction', async () => {
    const fake = createFakeManager();
    setActiveGeofenceManager(fake.manager);

    await runGeofenceTask({ data: { eventType: 1, region: { identifier: 'a' } } });
    await runGeofenceTask({ data: { eventType: 2, region: { identifier: 'b' } } });

    expect(fake.events).toEqual([
      { eventType: 'ENTER', identifier: 'a' },
      { eventType: 'EXIT', identifier: 'b' },
    ]);
  });

  it('drops an event whose direction it cannot read', async () => {
    const fake = createFakeManager();
    setActiveGeofenceManager(fake.manager);

    await runGeofenceTask({ data: { eventType: 7, region: { identifier: 'a' } } });
    await runGeofenceTask({ data: {} });
    await runGeofenceTask({ error: { message: 'kCLErrorDomain 1' } });

    expect(fake.events).toEqual([]);
  });

  it('survives an event delivered before the facade was evaluated', async () => {
    await expect(
      runGeofenceTask({ data: { eventType: 1, region: { identifier: 'a' } } }),
    ).resolves.toBeUndefined();
  });

  it('never rejects, whatever the manager does', async () => {
    const throwing = createFakeManager({
      handleRegionEvent: () => Promise.reject(new Error('database is not open')),
      syncRegions: () => Promise.reject(new Error('database is not open')),
    });
    setActiveGeofenceManager(throwing.manager);

    await expect(
      runGeofenceTask({ data: { eventType: 1, region: { identifier: 'a' } } }),
    ).resolves.toBeUndefined();
    await expect(runWakeTask()).resolves.toBeUndefined();
  });

  it('re-picks the monitored set when the wake channel fires', async () => {
    const fake = createFakeManager();
    setActiveGeofenceManager(fake.manager);

    await runWakeTask();

    expect(fake.syncs).toBe(1);
  });

  it('swallows a failed wake resync', async () => {
    const failing = createFakeManager({ syncRegions: async () => fail('permission_denied', 'no') });
    setActiveGeofenceManager(failing.manager);

    await expect(runWakeTask()).resolves.toBeUndefined();
  });
});
