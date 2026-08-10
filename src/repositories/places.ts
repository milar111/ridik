/**
 * Saved places — the named anchors behind every location reminder.
 *
 * A place is addressed by the words the user says ("the lab", "mum's"), so the
 * label is the identity: it is unique case-insensitively and saving the same
 * name again moves the pin rather than creating a second one.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { now } from '@/core/clock';
import { resolveOne } from '@/core/match';
import { AppError, fail, ok, type Result } from '@/core/result';
import { newId } from '@/db/ids';
import type { RidikDatabase } from '@/db/migrator';
import { savedPlaces, type SavedPlace } from '@/db/schema';

export type Coords = { latitude: number; longitude: number };

export type PlaceInput = {
  label: string;
  latitude: number;
  longitude: number;
  radiusMeters?: number;
  address?: string | null;
};

export const DEFAULT_PLACE_RADIUS_METERS = 150;

/** IUGG mean Earth radius; the figure the haversine formula is quoted with. */
const EARTH_RADIUS_METERS = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance between two points, in metres. */
export function distanceMeters(a: Coords, b: Coords): number {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  // asin is clamped: floating-point error can push `h` a hair above 1 for
  // antipodal points, which would otherwise produce NaN.
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function assertCoords(coords: Coords): void {
  const { latitude, longitude } = coords;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new AppError('invalid_input', `Latitude ${latitude} is out of range.`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new AppError('invalid_input', `Longitude ${longitude} is out of range.`);
  }
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function createPlacesRepository(db: RidikDatabase) {
  async function findByLabel(label: string): Promise<SavedPlace | null> {
    const rows = await db
      .select()
      .from(savedPlaces)
      // Matches the NOCASE unique index, so this finds exactly the row an
      // insert would collide with.
      .where(sql`${savedPlaces.label} = ${label} COLLATE NOCASE`)
      .limit(1);
    return rows[0] ?? null;
  }

  async function upsertPlace(input: PlaceInput): Promise<SavedPlace> {
    const label = input.label.trim();
    if (!label) throw new AppError('invalid_input', 'A place needs a name.');
    assertCoords(input);
    // Rounded before the check, because the column is an integer: a radius that
    // rounds down to zero is a circle nothing can ever be inside.
    const radiusMeters =
      input.radiusMeters === undefined ? undefined : Math.round(input.radiusMeters);
    if (radiusMeters !== undefined && (!Number.isFinite(radiusMeters) || radiusMeters <= 0)) {
      throw new AppError('invalid_input', `Radius ${input.radiusMeters} is not a usable distance.`);
    }

    const existing = await findByLabel(label);
    if (existing) {
      const rows = await db
        .update(savedPlaces)
        .set({
          // Keep the newest spelling the user used; the index is NOCASE so the
          // row stays unique either way.
          label,
          latitude: input.latitude,
          longitude: input.longitude,
          radiusMeters: radiusMeters ?? existing.radiusMeters,
          address: input.address === undefined ? existing.address : trimToNull(input.address),
        })
        .where(eq(savedPlaces.id, existing.id))
        .returning();
      return rows[0]!;
    }

    const rows = await db
      .insert(savedPlaces)
      .values({
        id: newId(),
        label,
        latitude: input.latitude,
        longitude: input.longitude,
        radiusMeters: radiusMeters ?? DEFAULT_PLACE_RADIUS_METERS,
        address: trimToNull(input.address),
        createdAt: now(),
      })
      .returning();
    return rows[0]!;
  }

  async function listPlaces(): Promise<SavedPlace[]> {
    return db.select().from(savedPlaces).orderBy(asc(savedPlaces.label));
  }

  async function getPlace(id: string): Promise<SavedPlace | null> {
    const rows = await db.select().from(savedPlaces).where(eq(savedPlaces.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async function resolvePlace(query: string): Promise<Result<SavedPlace>> {
    const places = await listPlaces();
    if (places.length === 0) return fail('not_found', 'No places are saved yet.');

    const outcome = resolveOne(
      query,
      places.map((place) => ({
        item: place,
        text: place.label,
        aux: place.address ? [place.address] : undefined,
      })),
    );
    if (outcome.kind === 'none') {
      return fail('not_found', `I do not know where "${query}" is.`);
    }
    if (outcome.kind === 'ambiguous') {
      return fail('ambiguous', `Did you mean ${outcome.matches.map((m) => m.text).join(' or ')}?`, {
        details: outcome.matches.map((m) => m.item),
      });
    }
    return ok(outcome.match.item);
  }

  async function deletePlace(id: string): Promise<boolean> {
    const rows = await db
      .delete(savedPlaces)
      .where(eq(savedPlaces.id, id))
      .returning({ id: savedPlaces.id });
    return rows.length > 0;
  }

  return { upsertPlace, listPlaces, getPlace, findByLabel, resolvePlace, deletePlace };
}

export type PlacesRepository = ReturnType<typeof createPlacesRepository>;
