/**
 * Location triggers — the data half of geofencing.
 *
 * Deliberately free of any native import: registering regions with the OS is a
 * service concern, and keeping the rules (which regions matter, whether a
 * crossing should actually fire) as plain functions is what makes them
 * testable. iOS monitors at most 20 regions per app, so the "which 20" decision
 * lives here rather than in the OS-facing layer.
 */
import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { now } from '@/core/clock';
import { AppError, fail, ok, type Result } from '@/core/result';
import { newId } from '@/db/ids';
import type { RidikDatabase } from '@/db/migrator';
import { geofenceTriggers, type GeofenceTrigger } from '@/db/schema';
import {
  assertCoords,
  createPlacesRepository,
  distanceMeters,
  type Coords,
} from '@/repositories/places';

export type TriggerType = 'ENTER' | 'EXIT';

export type CreateTriggerInput = {
  label: string;
  actionDescription: string;
  triggerType: TriggerType;
  latitude: number;
  longitude: number;
  radiusMeters?: number;
  oneShot?: boolean;
  cooldownSeconds?: number;
  expiresAt?: number | null;
  placeId?: string | null;
  taskId?: string | null;
};

export type CreateTriggerForPlaceInput = Omit<
  CreateTriggerInput,
  'label' | 'latitude' | 'longitude' | 'placeId'
> & {
  placeQuery: string;
  /** Defaults to the resolved place's own label. */
  label?: string;
};

export type TriggerOutcome = {
  /** False when cooldown, expiry, one-shot or deactivation suppressed it. */
  fired: boolean;
  trigger: GeofenceTrigger;
};

/**
 * Simultaneously monitored regions. iOS enforces 20 as a hard limit; Android
 * allows more but degrades well before it, so both platforms get the same
 * budget and the same prioritisation rather than two behaviours to reason about.
 */
export const MAX_MONITORED_REGIONS = 20;
export const DEFAULT_TRIGGER_RADIUS_METERS = 150;
export const DEFAULT_COOLDOWN_SECONDS = 900;

/**
 * Whether a crossing of this region should surface to the user right now.
 * Pure so the background task can ask before doing anything expensive.
 */
export function shouldFire(trigger: GeofenceTrigger, at: number): boolean {
  if (!(trigger.isActive ?? true)) return false;
  if (trigger.expiresAt !== null && at >= trigger.expiresAt) return false;
  if (trigger.lastTriggeredAt === null) return true;
  if (trigger.oneShot) return false;
  return at - trigger.lastTriggeredAt >= trigger.cooldownSeconds * 1000;
}

/** A spent one-shot stays in the table for history but must leave the OS. */
function isMonitorable(trigger: GeofenceTrigger, at: number): boolean {
  if (!(trigger.isActive ?? true)) return false;
  if (trigger.expiresAt !== null && at >= trigger.expiresAt) return false;
  return !(trigger.oneShot && trigger.lastTriggeredAt !== null);
}

/**
 * Picks the regions worth spending the OS budget on: ones that have never
 * fired, then the ones about to expire, then the nearest — the order in which
 * a missed region would cost the user most.
 */
export function selectRegionsToMonitor(
  triggers: readonly GeofenceTrigger[],
  currentLocation?: Coords,
): GeofenceTrigger[] {
  return [...triggers]
    .sort((a, b) => {
      const aFired = a.lastTriggeredAt === null ? 0 : 1;
      const bFired = b.lastTriggeredAt === null ? 0 : 1;
      if (aFired !== bFired) return aFired - bFired;

      const aExpiry = a.expiresAt ?? Number.POSITIVE_INFINITY;
      const bExpiry = b.expiresAt ?? Number.POSITIVE_INFINITY;
      if (aExpiry !== bExpiry) return aExpiry < bExpiry ? -1 : 1;

      if (currentLocation) {
        const delta = distanceMeters(currentLocation, a) - distanceMeters(currentLocation, b);
        if (delta !== 0) return delta;
      }

      return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    })
    .slice(0, MAX_MONITORED_REGIONS);
}

export function createGeofencesRepository(db: RidikDatabase) {
  const places = createPlacesRepository(db);

  async function createTrigger(input: CreateTriggerInput): Promise<GeofenceTrigger> {
    const label = input.label.trim();
    const actionDescription = input.actionDescription.trim();
    if (!label) throw new AppError('invalid_input', 'A location reminder needs a place name.');
    if (!actionDescription) {
      throw new AppError('invalid_input', 'A location reminder needs something to remind you of.');
    }
    if (input.triggerType !== 'ENTER' && input.triggerType !== 'EXIT') {
      throw new AppError('invalid_input', `"${input.triggerType}" is not ENTER or EXIT.`);
    }
    assertCoords(input);
    const requestedRadius = input.radiusMeters ?? DEFAULT_TRIGGER_RADIUS_METERS;
    // Rounded before the check, because the column is an integer: a radius that
    // rounds down to zero is a region the OS would never report a crossing of.
    const radiusMeters = Math.round(requestedRadius);
    if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
      throw new AppError('invalid_input', `Radius ${requestedRadius} is not a usable distance.`);
    }

    const rows = await db
      .insert(geofenceTriggers)
      .values({
        id: newId(),
        label,
        latitude: input.latitude,
        longitude: input.longitude,
        radiusMeters,
        triggerType: input.triggerType,
        actionDescription,
        isActive: true,
        placeId: input.placeId ?? null,
        taskId: input.taskId ?? null,
        oneShot: input.oneShot ?? true,
        cooldownSeconds: input.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS,
        lastTriggeredAt: null,
        expiresAt: input.expiresAt ?? null,
        registered: false,
        createdAt: now(),
      })
      .returning();
    return rows[0]!;
  }

  /**
   * The voice path: the user names a place instead of giving coordinates. An
   * unknown place is a normal outcome — the UI asks them to pin it.
   */
  async function createTriggerForPlace(
    input: CreateTriggerForPlaceInput,
  ): Promise<Result<GeofenceTrigger>> {
    const resolved = await places.resolvePlace(input.placeQuery);
    if (!resolved.ok) return resolved;
    const place = resolved.value;

    const trigger = await createTrigger({
      label: input.label ?? place.label,
      actionDescription: input.actionDescription,
      triggerType: input.triggerType,
      latitude: place.latitude,
      longitude: place.longitude,
      radiusMeters: input.radiusMeters ?? place.radiusMeters,
      oneShot: input.oneShot,
      cooldownSeconds: input.cooldownSeconds,
      expiresAt: input.expiresAt,
      placeId: place.id,
      taskId: input.taskId,
    });
    return ok(trigger);
  }

  async function getTrigger(id: string): Promise<GeofenceTrigger | null> {
    const rows = await db
      .select()
      .from(geofenceTriggers)
      .where(eq(geofenceTriggers.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async function listAllTriggers(): Promise<GeofenceTrigger[]> {
    return db.select().from(geofenceTriggers).orderBy(asc(geofenceTriggers.createdAt));
  }

  /** The set to hand the OS: live, unexpired, and never more than 20. */
  async function listActiveTriggers(
    options: { at?: number; currentLocation?: Coords } = {},
  ): Promise<GeofenceTrigger[]> {
    const at = options.at ?? now();
    const rows = await db
      .select()
      .from(geofenceTriggers)
      .where(
        and(
          // `is_active` is nullable, and every predicate above reads a null as
          // active; the SQL has to agree or a row would be live to `shouldFire`
          // yet never handed to the OS.
          or(isNull(geofenceTriggers.isActive), eq(geofenceTriggers.isActive, true)),
          or(isNull(geofenceTriggers.expiresAt), gt(geofenceTriggers.expiresAt, at)),
        ),
      )
      .orderBy(asc(geofenceTriggers.createdAt));

    return selectRegionsToMonitor(
      rows.filter((trigger) => isMonitorable(trigger, at)),
      options.currentLocation,
    );
  }

  async function markRegistered(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    // One statement rather than one per id: a crash mid-loop would otherwise
    // leave the table claiming regions are registered when they are not, and a
    // repeated id would be counted twice.
    const rows = await db
      .update(geofenceTriggers)
      .set({ registered: true })
      .where(inArray(geofenceTriggers.id, [...new Set(ids)]))
      .returning({ id: geofenceTriggers.id });
    return rows.length;
  }

  async function clearRegistered(): Promise<number> {
    const rows = await db
      .update(geofenceTriggers)
      .set({ registered: false })
      .where(eq(geofenceTriggers.registered, true))
      .returning({ id: geofenceTriggers.id });
    return rows.length;
  }

  /**
   * Records a region crossing. Returns whether the user should actually be
   * told, and burns the trigger when it was one-shot.
   */
  async function recordTrigger(id: string, at: number = now()): Promise<Result<TriggerOutcome>> {
    const trigger = await getTrigger(id);
    if (!trigger) return fail('not_found', 'That location reminder no longer exists.');
    if (!shouldFire(trigger, at)) return ok({ fired: false, trigger });

    const rows = await db
      .update(geofenceTriggers)
      .set({
        lastTriggeredAt: at,
        isActive: trigger.oneShot ? false : (trigger.isActive ?? true),
        registered: trigger.oneShot ? false : trigger.registered,
      })
      .where(eq(geofenceTriggers.id, id))
      .returning();
    return ok({ fired: true, trigger: rows[0]! });
  }

  async function deactivateTrigger(id: string): Promise<boolean> {
    const rows = await db
      .update(geofenceTriggers)
      .set({ isActive: false, registered: false })
      .where(eq(geofenceTriggers.id, id))
      .returning({ id: geofenceTriggers.id });
    return rows.length > 0;
  }

  async function deleteTrigger(id: string): Promise<boolean> {
    const rows = await db
      .delete(geofenceTriggers)
      .where(eq(geofenceTriggers.id, id))
      .returning({ id: geofenceTriggers.id });
    return rows.length > 0;
  }

  return {
    createTrigger,
    createTriggerForPlace,
    getTrigger,
    listAllTriggers,
    listActiveTriggers,
    markRegistered,
    clearRegistered,
    recordTrigger,
    deactivateTrigger,
    deleteTrigger,
  };
}

export type GeofencesRepository = ReturnType<typeof createGeofencesRepository>;
