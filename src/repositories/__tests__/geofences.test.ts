import { freezeClock } from '@/core/clock';
import { newId } from '@/db/ids';
import type { GeofenceTrigger } from '@/db/schema';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import {
  MAX_MONITORED_REGIONS,
  createGeofencesRepository,
  selectRegionsToMonitor,
  shouldFire,
  type GeofencesRepository,
} from '@/repositories/geofences';
import { createPlacesRepository, type PlacesRepository } from '@/repositories/places';

const SOFIA = { latitude: 42.6977, longitude: 23.3219 };
const NOW = 1_772_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function makeTrigger(overrides: Partial<GeofenceTrigger> = {}): GeofenceTrigger {
  return {
    id: newId(),
    label: 'The Lab',
    latitude: SOFIA.latitude,
    longitude: SOFIA.longitude,
    radiusMeters: 150,
    triggerType: 'ENTER',
    actionDescription: 'Grab the soldering iron',
    isActive: true,
    placeId: null,
    taskId: null,
    oneShot: true,
    cooldownSeconds: 900,
    lastTriggeredAt: null,
    expiresAt: null,
    registered: false,
    createdAt: NOW,
    ...overrides,
  };
}

describe('shouldFire', () => {
  it('fires a fresh, live trigger', () => {
    expect(shouldFire(makeTrigger(), NOW)).toBe(true);
  });

  it('never fires a deactivated trigger', () => {
    expect(shouldFire(makeTrigger({ isActive: false }), NOW)).toBe(false);
  });

  it('never fires an expired trigger', () => {
    expect(shouldFire(makeTrigger({ expiresAt: NOW - 1 }), NOW)).toBe(false);
    expect(shouldFire(makeTrigger({ expiresAt: NOW + 1 }), NOW)).toBe(true);
  });

  it('never fires a one-shot twice', () => {
    const spent = makeTrigger({ oneShot: true, lastTriggeredAt: NOW - 30 * DAY });
    expect(shouldFire(spent, NOW)).toBe(false);
  });

  it('suppresses a repeating trigger inside its cooldown', () => {
    const cooling = makeTrigger({
      oneShot: false,
      cooldownSeconds: 900,
      lastTriggeredAt: NOW - 14 * MINUTE,
    });
    expect(shouldFire(cooling, NOW)).toBe(false);
    expect(shouldFire(cooling, NOW + MINUTE)).toBe(true);
  });
});

describe('selectRegionsToMonitor', () => {
  it('caps the set at the OS limit', () => {
    const triggers = Array.from({ length: 25 }, (_, i) => makeTrigger({ createdAt: NOW + i }));
    expect(selectRegionsToMonitor(triggers)).toHaveLength(MAX_MONITORED_REGIONS);
  });

  it('prefers regions that have never fired', () => {
    const fired = Array.from({ length: 5 }, (_, i) =>
      makeTrigger({ oneShot: false, lastTriggeredAt: NOW - i * HOUR, createdAt: NOW + i }),
    );
    const fresh = Array.from({ length: 20 }, (_, i) => makeTrigger({ createdAt: NOW + 100 + i }));

    const selected = selectRegionsToMonitor([...fired, ...fresh]);
    expect(selected).toHaveLength(20);
    expect(selected.every((t) => t.lastTriggeredAt === null)).toBe(true);
  });

  it('puts sooner-expiring regions first and open-ended ones last', () => {
    const openEnded = makeTrigger({ label: 'open', createdAt: NOW });
    const later = makeTrigger({ label: 'later', expiresAt: NOW + 7 * DAY, createdAt: NOW + 1 });
    const sooner = makeTrigger({ label: 'sooner', expiresAt: NOW + DAY, createdAt: NOW + 2 });

    expect(selectRegionsToMonitor([openEnded, later, sooner]).map((t) => t.label)).toEqual([
      'sooner',
      'later',
      'open',
    ]);
  });

  it('breaks ties by distance when a location is supplied', () => {
    const far = makeTrigger({ label: 'far', latitude: 43.2, longitude: 27.9, createdAt: NOW });
    const near = makeTrigger({ label: 'near', latitude: 42.7, longitude: 23.33, createdAt: NOW + 1 });
    const middle = makeTrigger({ label: 'middle', latitude: 42.15, longitude: 24.75, createdAt: NOW + 2 });

    expect(selectRegionsToMonitor([far, near, middle], SOFIA).map((t) => t.label)).toEqual([
      'near',
      'middle',
      'far',
    ]);
    // Without a location the order falls back to creation order.
    expect(selectRegionsToMonitor([far, near, middle]).map((t) => t.label)).toEqual([
      'far',
      'near',
      'middle',
    ]);
  });

  it('keeps a distant never-fired region ahead of a nearby spent one', () => {
    const nearbySpent = makeTrigger({
      label: 'spent',
      oneShot: false,
      lastTriggeredAt: NOW - DAY,
      latitude: 42.6978,
      longitude: 23.322,
    });
    const distantFresh = makeTrigger({ label: 'fresh', latitude: 43.2, longitude: 27.9 });

    expect(selectRegionsToMonitor([nearbySpent, distantFresh], SOFIA).map((t) => t.label)).toEqual([
      'fresh',
      'spent',
    ]);
  });

  it('does not mutate the input array', () => {
    const triggers = [
      makeTrigger({ label: 'b', expiresAt: NOW + 2 * DAY }),
      makeTrigger({ label: 'a', expiresAt: NOW + DAY }),
    ];
    selectRegionsToMonitor(triggers);
    expect(triggers.map((t) => t.label)).toEqual(['b', 'a']);
  });
});

describe('geofences repository', () => {
  let t: TestDatabase;
  let repo: GeofencesRepository;
  let places: PlacesRepository;
  let restoreClock: () => void;

  beforeEach(() => {
    t = createTestDatabase();
    repo = createGeofencesRepository(t.db);
    places = createPlacesRepository(t.db);
    restoreClock = freezeClock(NOW);
  });

  afterEach(() => {
    restoreClock();
    t.close();
  });

  it('creates a trigger with sane defaults', async () => {
    const trigger = await repo.createTrigger({
      label: 'The Lab',
      actionDescription: 'Grab the soldering iron',
      triggerType: 'ENTER',
      ...SOFIA,
    });

    expect(trigger.radiusMeters).toBe(150);
    expect(trigger.oneShot).toBe(true);
    expect(trigger.cooldownSeconds).toBe(900);
    expect(trigger.isActive).toBe(true);
    expect(trigger.registered).toBe(false);
    expect(trigger.lastTriggeredAt).toBeNull();
    expect(trigger.createdAt).toBe(NOW);
  });

  it('rejects malformed triggers', async () => {
    const base = {
      label: 'The Lab',
      actionDescription: 'Grab the iron',
      triggerType: 'ENTER' as const,
      ...SOFIA,
    };
    await expect(repo.createTrigger({ ...base, label: ' ' })).rejects.toThrow(/place name/);
    await expect(repo.createTrigger({ ...base, actionDescription: ' ' })).rejects.toThrow(
      /remind you/,
    );
    await expect(repo.createTrigger({ ...base, latitude: 120 })).rejects.toThrow(/Latitude/);
    await expect(
      repo.createTrigger({ ...base, triggerType: 'SIDEWAYS' as never }),
    ).rejects.toThrow(/ENTER or EXIT/);
    // Would round away to a zero-metre region the OS could never report.
    await expect(repo.createTrigger({ ...base, radiusMeters: 0.4 })).rejects.toThrow(/Radius/);
  });

  it('rounds the radius to whole metres', async () => {
    const trigger = await repo.createTrigger({
      label: 'The Lab',
      actionDescription: 'x',
      triggerType: 'ENTER',
      ...SOFIA,
      radiusMeters: 250.7,
    });
    expect(trigger.radiusMeters).toBe(251);
  });

  it('creates a trigger from a saved place', async () => {
    const place = await places.upsertPlace({
      label: 'The Lab',
      ...SOFIA,
      radiusMeters: 250,
      address: 'Tsarigradsko shose 8',
    });

    const created = await repo.createTriggerForPlace({
      placeQuery: 'the lab',
      actionDescription: 'Grab the soldering iron',
      triggerType: 'EXIT',
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.placeId).toBe(place.id);
    expect(created.value.label).toBe('The Lab');
    expect(created.value.latitude).toBe(SOFIA.latitude);
    expect(created.value.radiusMeters).toBe(250);
    expect(created.value.triggerType).toBe('EXIT');
  });

  it('reports not_found when the place has never been pinned', async () => {
    const outcome = await repo.createTriggerForPlace({
      placeQuery: 'the observatory',
      actionDescription: 'Return the telescope key',
      triggerType: 'ENTER',
    });
    expect(!outcome.ok && outcome.error.code).toBe('not_found');
    expect(await repo.listAllTriggers()).toHaveLength(0);
  });

  it('fires a one-shot exactly once and retires it', async () => {
    const trigger = await repo.createTrigger({
      label: 'The Lab',
      actionDescription: 'Grab the soldering iron',
      triggerType: 'ENTER',
      ...SOFIA,
    });

    const first = await repo.recordTrigger(trigger.id, NOW);
    expect(first.ok && first.value.fired).toBe(true);
    expect(first.ok && first.value.trigger.lastTriggeredAt).toBe(NOW);
    expect(first.ok && first.value.trigger.isActive).toBe(false);

    const second = await repo.recordTrigger(trigger.id, NOW + DAY);
    expect(second.ok && second.value.fired).toBe(false);
    expect(second.ok && second.value.trigger.lastTriggeredAt).toBe(NOW);
    expect(await repo.listActiveTriggers({ at: NOW + DAY })).toHaveLength(0);
  });

  it('suppresses a repeating trigger until its cooldown elapses', async () => {
    const trigger = await repo.createTrigger({
      label: 'Gym',
      actionDescription: 'Log the session',
      triggerType: 'EXIT',
      ...SOFIA,
      oneShot: false,
      cooldownSeconds: 900,
    });

    expect((await repo.recordTrigger(trigger.id, NOW)).ok).toBe(true);

    const tooSoon = await repo.recordTrigger(trigger.id, NOW + 10 * MINUTE);
    expect(tooSoon.ok && tooSoon.value.fired).toBe(false);
    expect(tooSoon.ok && tooSoon.value.trigger.lastTriggeredAt).toBe(NOW);

    const later = await repo.recordTrigger(trigger.id, NOW + 16 * MINUTE);
    expect(later.ok && later.value.fired).toBe(true);
    expect(later.ok && later.value.trigger.lastTriggeredAt).toBe(NOW + 16 * MINUTE);
    // A repeating trigger stays live and stays registered.
    expect(later.ok && later.value.trigger.isActive).toBe(true);
  });

  it('will not record a crossing for an unknown trigger', async () => {
    const outcome = await repo.recordTrigger('missing', NOW);
    expect(!outcome.ok && outcome.error.code).toBe('not_found');
  });

  it('hands the OS at most twenty live regions', async () => {
    for (let i = 0; i < 23; i++) {
      await repo.createTrigger({
        label: `Spot ${i}`,
        actionDescription: 'Do the thing',
        triggerType: 'ENTER',
        latitude: SOFIA.latitude + i * 0.01,
        longitude: SOFIA.longitude,
      });
    }
    const active = await repo.listActiveTriggers({ at: NOW });
    expect(active).toHaveLength(MAX_MONITORED_REGIONS);
    expect(new Set(active.map((tr) => tr.id)).size).toBe(MAX_MONITORED_REGIONS);
  });

  it('leaves out expired and deactivated regions', async () => {
    const live = await repo.createTrigger({
      label: 'Live',
      actionDescription: 'x',
      triggerType: 'ENTER',
      ...SOFIA,
    });
    const expiring = await repo.createTrigger({
      label: 'Expiring',
      actionDescription: 'x',
      triggerType: 'ENTER',
      ...SOFIA,
      expiresAt: NOW + HOUR,
    });
    const off = await repo.createTrigger({
      label: 'Off',
      actionDescription: 'x',
      triggerType: 'ENTER',
      ...SOFIA,
    });
    await repo.deactivateTrigger(off.id);

    expect((await repo.listActiveTriggers({ at: NOW })).map((tr) => tr.id)).toEqual([
      expiring.id,
      live.id,
    ]);
    expect((await repo.listActiveTriggers({ at: NOW + 2 * HOUR })).map((tr) => tr.id)).toEqual([
      live.id,
    ]);
    expect(await repo.listAllTriggers()).toHaveLength(3);
  });

  it('tracks which regions are currently handed to the OS', async () => {
    const a = await repo.createTrigger({
      label: 'A',
      actionDescription: 'x',
      triggerType: 'ENTER',
      ...SOFIA,
    });
    const b = await repo.createTrigger({
      label: 'B',
      actionDescription: 'x',
      triggerType: 'ENTER',
      ...SOFIA,
    });

    expect(await repo.markRegistered([a.id, b.id, 'ghost'])).toBe(2);
    expect((await repo.listAllTriggers()).every((tr) => tr.registered)).toBe(true);

    expect(await repo.clearRegistered()).toBe(2);
    expect((await repo.listAllTriggers()).some((tr) => tr.registered)).toBe(false);

    // The count is regions actually registered, so a repeated id cannot inflate
    // it — the caller uses it to reconcile against the OS budget.
    expect(await repo.markRegistered([a.id, a.id, a.id])).toBe(1);
    expect(await repo.markRegistered([])).toBe(0);
  });

  it('deactivates and deletes', async () => {
    const trigger = await repo.createTrigger({
      label: 'The Lab',
      actionDescription: 'x',
      triggerType: 'ENTER',
      ...SOFIA,
    });
    await repo.markRegistered([trigger.id]);

    expect(await repo.deactivateTrigger(trigger.id)).toBe(true);
    const off = await repo.getTrigger(trigger.id);
    expect(off?.isActive).toBe(false);
    expect(off?.registered).toBe(false);

    expect(await repo.deleteTrigger(trigger.id)).toBe(true);
    expect(await repo.deleteTrigger(trigger.id)).toBe(false);
    expect(await repo.getTrigger(trigger.id)).toBeNull();
  });

  it('keeps the trigger when its place is deleted', async () => {
    await places.upsertPlace({ label: 'The Lab', ...SOFIA });
    const created = await repo.createTriggerForPlace({
      placeQuery: 'the lab',
      actionDescription: 'x',
      triggerType: 'ENTER',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const place = await places.findByLabel('The Lab');
    await places.deletePlace(place!.id);

    const orphan = await repo.getTrigger(created.value.id);
    expect(orphan?.placeId).toBeNull();
    expect(orphan?.latitude).toBe(SOFIA.latitude);
  });
});
