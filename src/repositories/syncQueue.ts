/**
 * Offline-first outbox.
 *
 * Mutations are recorded here the moment they happen and drained by a
 * background worker. The queue owns retry policy so every caller — calendar,
 * tasks, anything added later — backs off identically and a phone that has been
 * in a tunnel for an hour does not stampede the API on reconnect.
 */
import { and, asc, eq, inArray, lte, lt, ne, sql } from 'drizzle-orm';

import { now } from '@/core/clock';
import { fail, ok, type Result } from '@/core/result';
import { newId } from '@/db/ids';
import type { RidikDatabase } from '@/db/migrator';
import { syncQueue, type SyncQueueEntry } from '@/db/schema';

import { serialised, transactional } from './transaction';

export type SyncStatus = SyncQueueEntry['status'];

export type EnqueueInput = {
  operation: string;
  entityTable: string;
  entityId: string;
  payload: unknown;
};

export type BackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  /** Fractional spread, e.g. 0.2 for plus/minus 20%. */
  jitter?: number;
  /** Injectable for deterministic tests; must return [0, 1). */
  random?: () => number;
};

export const MAX_SYNC_ATTEMPTS = 8;
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 30 * 60_000;
export const BACKOFF_JITTER = 0.2;

/**
 * `min(baseMs * 2^attempts, maxMs)` spread by plus/minus `jitter`.
 *
 * `attempts` is the number of failures *before* this delay, so the first retry
 * waits `baseMs`. Jitter keeps a fleet of devices that all lost connectivity at
 * the same moment from retrying in lockstep.
 */
export function computeBackoff(attempts: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? BACKOFF_BASE_MS;
  const maxMs = options.maxMs ?? BACKOFF_MAX_MS;
  const jitter = options.jitter ?? BACKOFF_JITTER;
  const random = options.random ?? Math.random;

  const exponent = Math.max(0, Math.floor(attempts));
  const delay = Math.min(baseMs * 2 ** exponent, maxMs);
  const spread = (random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(delay * (1 + spread)));
}

export function decodePayload<T = unknown>(entry: SyncQueueEntry): T | null {
  try {
    return JSON.parse(entry.payload) as T;
  } catch {
    return null;
  }
}

export function createSyncQueueRepository(db: RidikDatabase) {
  async function getById(id: string): Promise<SyncQueueEntry | null> {
    const [row] = await db.select().from(syncQueue).where(eq(syncQueue.id, id));
    return row ?? null;
  }

  return {
    getById,

    /**
     * Dedupes on (operation, entityId): two edits to the same event before the
     * worker wakes up must produce one push carrying the newer payload, not two
     * pushes racing each other. The existing row keeps its attempt count so a
     * rewrite cannot reset an in-progress backoff.
     */
    async enqueue(input: EnqueueInput): Promise<SyncQueueEntry> {
      const at = now();
      const payload = JSON.stringify(input.payload ?? null);

      // Look-then-write: without the queue two overlapping edits to the same
      // event both find nothing and both insert, which is the duplicate push
      // this method exists to prevent.
      return transactional(db, async () => {
        const [existing] = await db
          .select()
          .from(syncQueue)
          .where(
            and(
              eq(syncQueue.operation, input.operation),
              eq(syncQueue.entityId, input.entityId),
              eq(syncQueue.status, 'pending'),
            ),
          )
          .orderBy(asc(syncQueue.createdAt))
          .limit(1);

        if (existing) {
          const [updated] = await db
            .update(syncQueue)
            .set({ payload, entityTable: input.entityTable, updatedAt: at })
            .where(eq(syncQueue.id, existing.id))
            .returning();
          return updated!;
        }

        const [row] = await db
          .insert(syncQueue)
          .values({
            id: newId(),
            operation: input.operation,
            entityTable: input.entityTable,
            entityId: input.entityId,
            payload,
            status: 'pending',
            attempts: 0,
            nextAttemptAt: at,
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        return row!;
      });
    },

    /** Selects and flags in one transaction so two workers cannot claim a row twice. */
    async claimReady(nowMs: number, limit = 20): Promise<SyncQueueEntry[]> {
      return transactional(db, async () => {
        const ready = await db
          .select()
          .from(syncQueue)
          .where(and(eq(syncQueue.status, 'pending'), lte(syncQueue.nextAttemptAt, nowMs)))
          .orderBy(asc(syncQueue.nextAttemptAt), asc(syncQueue.createdAt))
          .limit(limit);

        if (ready.length > 0) {
          await db
            .update(syncQueue)
            .set({ status: 'in_flight', updatedAt: nowMs })
            .where(
              inArray(
                syncQueue.id,
                ready.map((row) => row.id),
              ),
            );
        }
        return ready.map((row) => ({ ...row, status: 'in_flight' as const, updatedAt: nowMs }));
      });
    },

    async markDone(id: string): Promise<Result<SyncQueueEntry>> {
      const at = now();
      return serialised(db, async () => {
        const [row] = await db
          .update(syncQueue)
          .set({ status: 'done', lastError: null, updatedAt: at })
          .where(eq(syncQueue.id, id))
          .returning();
        return row ? ok(row) : fail('not_found', 'That queued change is no longer here.');
      });
    },

    async markFailed(
      id: string,
      error: string,
      options: BackoffOptions = {},
    ): Promise<Result<SyncQueueEntry>> {
      // Reads the attempt count then writes it back, so it has to queue or two
      // concurrent failures both bump 0 -> 1 and the backoff never grows.
      return serialised(db, async () => {
        const current = await getById(id);
        if (!current) return fail('not_found', 'That queued change is no longer here.');

        const at = now();
        const attempts = current.attempts + 1;
        const exhausted = attempts >= MAX_SYNC_ATTEMPTS;
        const [row] = await db
          .update(syncQueue)
          .set({
            attempts,
            status: exhausted ? 'failed' : 'pending',
            // Backoff is derived from the count *before* this failure, so the
            // first retry waits one base interval rather than two.
            nextAttemptAt: exhausted ? at : at + computeBackoff(current.attempts, options),
            lastError: error,
            updatedAt: at,
          })
          .where(eq(syncQueue.id, id))
          .returning();
        return row ? ok(row) : fail('not_found', 'That queued change is no longer here.');
      });
    },

    /** Recovers rows a crashed (or force-quit) worker left flagged in_flight. */
    async releaseStale(nowMs: number, staleAfterMs: number): Promise<number> {
      return serialised(db, async () => {
        const rows = await db
          .update(syncQueue)
          .set({ status: 'pending', nextAttemptAt: nowMs, updatedAt: nowMs })
          .where(
            and(
              eq(syncQueue.status, 'in_flight'),
              lte(syncQueue.updatedAt, nowMs - staleAfterMs),
            ),
          )
          .returning({ id: syncQueue.id });
        return rows.length;
      });
    },

    async counts(): Promise<{ pending: number; inFlight: number; failed: number }> {
      const rows = await db
        .select({ status: syncQueue.status, total: sql<number>`count(*)` })
        .from(syncQueue)
        .groupBy(syncQueue.status);

      const byStatus = new Map(rows.map((row) => [row.status, Number(row.total)]));
      return {
        pending: byStatus.get('pending') ?? 0,
        inFlight: byStatus.get('in_flight') ?? 0,
        failed: byStatus.get('failed') ?? 0,
      };
    },

    async retryFailed(): Promise<number> {
      const at = now();
      return serialised(db, async () => {
        const rows = await db
          .update(syncQueue)
          .set({ status: 'pending', attempts: 0, nextAttemptAt: at, lastError: null, updatedAt: at })
          .where(eq(syncQueue.status, 'failed'))
          .returning({ id: syncQueue.id });
        return rows.length;
      });
    },

    async purgeDone(before: number): Promise<number> {
      return serialised(db, async () => {
        const rows = await db
          .delete(syncQueue)
          .where(and(eq(syncQueue.status, 'done'), lt(syncQueue.updatedAt, before)))
          .returning({ id: syncQueue.id });
        return rows.length;
      });
    },

    async listByStatus(status: SyncStatus, limit = 100): Promise<SyncQueueEntry[]> {
      return db
        .select()
        .from(syncQueue)
        .where(eq(syncQueue.status, status))
        .orderBy(asc(syncQueue.createdAt))
        .limit(limit);
    },

    async listForEntity(entityId: string): Promise<SyncQueueEntry[]> {
      return db
        .select()
        .from(syncQueue)
        .where(and(eq(syncQueue.entityId, entityId), ne(syncQueue.status, 'done')))
        .orderBy(asc(syncQueue.createdAt));
    },
  };
}

export type SyncQueueRepository = ReturnType<typeof createSyncQueueRepository>;

export type { SyncQueueEntry };
