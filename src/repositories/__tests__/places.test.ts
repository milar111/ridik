import { createTestDatabase, type TestDatabase } from '@/db/testing';
import {
  createPlacesRepository,
  distanceMeters,
  type PlacesRepository,
} from '@/repositories/places';

/** Landmarks with widely published great-circle distances between them. */
const LIBERTY = { latitude: 40.6892, longitude: -74.0445 };
const EIFFEL = { latitude: 48.8584, longitude: 2.2945 };
const SOFIA = { latitude: 42.6977, longitude: 23.3219 };

describe('distanceMeters', () => {
  it('is zero for the same point', () => {
    expect(distanceMeters(SOFIA, SOFIA)).toBe(0);
  });

  it('matches one degree of latitude', () => {
    const oneDegree = distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
    expect(oneDegree).toBeCloseTo(111_195, -1);
  });

  it('matches the Statue of Liberty to the Eiffel Tower', () => {
    // The textbook haversine example: ~5,837 km.
    expect(distanceMeters(LIBERTY, EIFFEL)).toBeGreaterThan(5_830_000);
    expect(distanceMeters(LIBERTY, EIFFEL)).toBeLessThan(5_845_000);
  });

  it('is symmetric', () => {
    expect(distanceMeters(EIFFEL, LIBERTY)).toBeCloseTo(distanceMeters(LIBERTY, EIFFEL), 6);
  });

  it('stays finite for antipodal points', () => {
    const half = distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 });
    expect(Number.isFinite(half)).toBe(true);
    expect(half).toBeCloseTo(20_015_114, -2);
  });

  it('resolves short distances accurately', () => {
    // 0.01219 degrees of longitude at Sofia's latitude is very close to 1 km.
    const km = distanceMeters(SOFIA, { latitude: SOFIA.latitude, longitude: 23.33409 });
    expect(km).toBeGreaterThan(990);
    expect(km).toBeLessThan(1010);
  });
});

describe('places repository', () => {
  let t: TestDatabase;
  let repo: PlacesRepository;

  beforeEach(() => {
    t = createTestDatabase();
    repo = createPlacesRepository(t.db);
  });
  afterEach(() => t.close());

  it('creates a place with the default radius', async () => {
    const place = await repo.upsertPlace({ label: 'The Lab', ...SOFIA });
    expect(place.radiusMeters).toBe(150);
    expect(place.address).toBeNull();
    expect(await repo.listPlaces()).toHaveLength(1);
  });

  it('upserts case-insensitively instead of duplicating the label', async () => {
    const first = await repo.upsertPlace({
      label: 'The Lab',
      ...SOFIA,
      radiusMeters: 200,
      address: 'Tsarigradsko shose 8',
    });
    const second = await repo.upsertPlace({
      label: 'the lab',
      latitude: 42.7,
      longitude: 23.33,
    });

    expect(second.id).toBe(first.id);
    expect(second.label).toBe('the lab');
    expect(second.latitude).toBe(42.7);
    // Fields the caller left out survive the move.
    expect(second.radiusMeters).toBe(200);
    expect(second.address).toBe('Tsarigradsko shose 8');
    expect(await repo.listPlaces()).toHaveLength(1);
  });

  it('clears an address when one is explicitly passed as null', async () => {
    await repo.upsertPlace({ label: 'Home', ...SOFIA, address: 'Somewhere' });
    const cleared = await repo.upsertPlace({ label: 'Home', ...SOFIA, address: null });
    expect(cleared.address).toBeNull();
  });

  it('rejects impossible coordinates and radii', async () => {
    await expect(repo.upsertPlace({ label: 'Nowhere', latitude: 91, longitude: 0 })).rejects.toThrow(
      /Latitude/,
    );
    await expect(
      repo.upsertPlace({ label: 'Nowhere', latitude: 0, longitude: 200 }),
    ).rejects.toThrow(/Longitude/);
    await expect(
      repo.upsertPlace({ label: 'Nowhere', ...SOFIA, radiusMeters: 0 }),
    ).rejects.toThrow(/Radius/);
    await expect(repo.upsertPlace({ label: '  ', ...SOFIA })).rejects.toThrow(/needs a name/);
  });

  it('keeps the radius a whole number of metres', async () => {
    const place = await repo.upsertPlace({ label: 'Lab', ...SOFIA, radiusMeters: 250.7 });
    expect(place.radiusMeters).toBe(251);
    // A radius that would round away to nothing is not a usable circle.
    await expect(repo.upsertPlace({ label: 'Dot', ...SOFIA, radiusMeters: 0.4 })).rejects.toThrow(
      /Radius/,
    );
  });

  it('stores a label containing SQL punctuation verbatim', async () => {
    const evil = "x'; DROP TABLE saved_places; --";
    const place = await repo.upsertPlace({ label: evil, ...SOFIA });
    expect(place.label).toBe(evil);
    expect((await repo.findByLabel(evil))?.id).toBe(place.id);
    expect(await repo.listPlaces()).toHaveLength(1);
  });

  it('resolves a place by fuzzy label and by address', async () => {
    await repo.upsertPlace({ label: 'The Lab', ...SOFIA });
    await repo.upsertPlace({
      label: "Mum's",
      latitude: 42.15,
      longitude: 24.75,
      address: 'Ivan Vazov 12, Plovdiv',
    });

    const byLabel = await repo.resolvePlace('lab');
    expect(byLabel.ok && byLabel.value.label).toBe('The Lab');

    const byAddress = await repo.resolvePlace('Ivan Vazov 12');
    expect(byAddress.ok && byAddress.value.label).toBe("Mum's");

    const miss = await repo.resolvePlace('the moon');
    expect(!miss.ok && miss.error.code).toBe('not_found');
  });

  it('asks rather than guesses between near-identical labels', async () => {
    await repo.upsertPlace({ label: 'Lab', ...SOFIA });
    await repo.upsertPlace({ label: 'Labs', latitude: 42.7, longitude: 23.33 });

    const outcome = await repo.resolvePlace('lab');
    expect(!outcome.ok && outcome.error.code).toBe('ambiguous');
  });

  it('reports an empty book of places', async () => {
    const outcome = await repo.resolvePlace('lab');
    expect(!outcome.ok && outcome.error.code).toBe('not_found');
  });

  it('gets and deletes by id', async () => {
    const place = await repo.upsertPlace({ label: 'The Lab', ...SOFIA });
    expect((await repo.getPlace(place.id))?.label).toBe('The Lab');
    expect(await repo.deletePlace(place.id)).toBe(true);
    expect(await repo.deletePlace(place.id)).toBe(false);
    expect(await repo.getPlace(place.id)).toBeNull();
  });
});
