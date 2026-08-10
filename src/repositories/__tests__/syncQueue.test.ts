import { freezeClock } from '@/core/clock';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  MAX_SYNC_ATTEMPTS,
  computeBackoff,
  createSyncQueueRepository,
  decodePayload,
  type SyncQueueRepository,
} from '@/repositories/syncQueue';

const NOW = 1_780_000_000_000;
/** Injected RNG at the midpoint cancels the jitter term entirely. */
const noJitter = () => 0.5;

describe('computeBackoff', () => {
  it('doubles with each recorded attempt', () => {
    const delays = [0, 1, 2, 3, 4].map((attempts) =>
      computeBackoff(attempts, { baseMs: 1000, maxMs: 10 * 60_000, random: noJitter }),
    );
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000]);
  });

  it('caps at maxMs no matter how many attempts have piled up', () => {
    expect(computeBackoff(20, { baseMs: 1000, maxMs: 60_000, random: noJitter })).toBe(60_000);
    expect(computeBackoff(2000, { baseMs: 1000, maxMs: 60_000, random: noJitter })).toBe(60_000);
  });

  it('spreads by plus/minus the jitter fraction', () => {
    const options = { baseMs: 1000, maxMs: 60_000, jitter: 0.2 };
    expect(computeBackoff(3, { ...options, random: () => 0 })).toBe(6400);
    expect(computeBackoff(3, { ...options, random: () => 1 })).toBe(9600);
    expect(computeBackoff(3, { ...options, random: () => 0.5 })).toBe(8000);
  });

  it('keeps every draw inside the jitter bounds', () => {
    const draws = [0, 0.13, 0.37, 0.5, 0.62, 0.88, 0.999];
    for (const value of draws) {
      const delay = computeBackoff(2, {
        baseMs: 5000,
        maxMs: 60_000,
        jitter: 0.2,
        random: () => value,
      });
      expect(delay).toBeGreaterThanOrEqual(16_000);
      expect(delay).toBeLessThanOrEqual(24_000);
    }
  });

  it('treats a negative attempt count as the first attempt', () => {
    expect(computeBackoff(-3, { baseMs: 1000, random: noJitter })).toBe(1000);
  });

  it('uses the shipped defaults when nothing is injected', () => {
    const delay = computeBackoff(0);
    expect(delay).toBeGreaterThanOrEqual(BACKOFF_BASE_MS * 0.8);
    expect(delay).toBeLessThanOrEqual(BACKOFF_BASE_MS * 1.2);
    expect(computeBackoff(64)).toBeLessThanOrEqual(BACKOFF_MAX_MS * 1.2);
  });
});

describe('sync queue repository', () => {
  let t: TestDatabase;
  let repo: SyncQueueRepository;
  let restoreClock: () => void;

  beforeEach(() => {
    restoreClock = freezeClock(NOW);
    t = createTestDatabase();
    repo = createSyncQueueRepository(t.db);
  });

  afterEach(() => {
    restoreClock();
    t.close();
  });

  const enqueueUpdate = (entityId: string, payload: unknown) =>
    repo.enqueue({
      operation: 'calendar.update',
      entityTable: 'calendar_events',
      entityId,
      payload,
    });

  it('stores the payload as JSON and schedules it immediately', async () => {
    const entry = await enqueueUpdate('evt-1', { title: 'Dentist' });

    expect(entry.status).toBe('pending');
    expect(entry.attempts).toBe(0);
    expect(entry.nextAttemptAt).toBe(NOW);
    expect(entry.payload).toBe('{"title":"Dentist"}');
    expect(decodePayload<{ title: string }>(entry)).toEqual({ title: 'Dentist' });
  });

  it('dedupes on (operation, entityId), keeping the newest pending payload', async () => {
    const first = await enqueueUpdate('evt-1', { title: 'Dentist' });
    const second = await enqueueUpdate('evt-1', { title: 'Dentist, moved' });

    expect(second.id).toBe(first.id);
    expect(decodePayload(second)).toEqual({ title: 'Dentist, moved' });
    expect(await repo.listByStatus('pending')).toHaveLength(1);
  });

  it('still dedupes when two enqueues overlap', async () => {
    // Look-then-write: unqueued, both calls find nothing and both insert, and
    // the worker pushes the same event twice.
    const [first, second] = await Promise.all([
      enqueueUpdate('evt-1', { title: 'Dentist' }),
      enqueueUpdate('evt-1', { title: 'Dentist, moved' }),
    ]);

    expect(second!.id).toBe(first!.id);
    expect(await repo.listByStatus('pending')).toHaveLength(1);
    expect(decodePayload(await repo.getById(first!.id) as never)).toEqual({
      title: 'Dentist, moved',
    });
  });

  it('counts each concurrent failure separately', async () => {
    const entry = await enqueueUpdate('evt-1', { n: 1 });
    await Promise.all([
      repo.markFailed(entry.id, 'a', { random: noJitter }),
      repo.markFailed(entry.id, 'b', { random: noJitter }),
    ]);
    // Unqueued, both read attempts=0 and both write 1, so the backoff stalls.
    expect((await repo.getById(entry.id))?.attempts).toBe(2);
  });

  it('keeps a different operation on the same entity separate', async () => {
    await enqueueUpdate('evt-1', { title: 'Dentist' });
    await repo.enqueue({
      operation: 'calendar.delete',
      entityTable: 'calendar_events',
      entityId: 'evt-1',
      payload: null,
    });
    expect(await repo.listByStatus('pending')).toHaveLength(2);
  });

  it('does not fold a new change into a row already in flight', async () => {
    await enqueueUpdate('evt-1', { title: 'Dentist' });
    await repo.claimReady(NOW, 10);
    const fresh = await enqueueUpdate('evt-1', { title: 'Dentist again' });

    expect(fresh.status).toBe('pending');
    expect(await repo.listForEntity('evt-1')).toHaveLength(2);
  });

  describe('claimReady', () => {
    it('flags the claimed rows in_flight and returns them oldest-first', async () => {
      await enqueueUpdate('evt-1', { n: 1 });
      await enqueueUpdate('evt-2', { n: 2 });

      const claimed = await repo.claimReady(NOW, 10);
      expect(claimed.map((row) => row.entityId)).toEqual(['evt-1', 'evt-2']);
      expect(claimed.every((row) => row.status === 'in_flight')).toBe(true);

      expect(await repo.counts()).toEqual({ pending: 0, inFlight: 2, failed: 0 });
      expect(await repo.claimReady(NOW, 10)).toEqual([]);
    });

    it('honours the limit and the scheduled retry time', async () => {
      await enqueueUpdate('evt-1', { n: 1 });
      await enqueueUpdate('evt-2', { n: 2 });
      await enqueueUpdate('evt-3', { n: 3 });

      expect(await repo.claimReady(NOW, 2)).toHaveLength(2);

      const remaining = await repo.claimReady(NOW, 10);
      expect(remaining).toHaveLength(1);

      const failed = await repo.markFailed(remaining[0]!.id, 'boom', { random: noJitter });
      expect(failed.ok).toBe(true);
      if (!failed.ok) return;
      expect(failed.value.nextAttemptAt).toBe(NOW + BACKOFF_BASE_MS);

      expect(await repo.claimReady(NOW, 10)).toEqual([]);
      expect(await repo.claimReady(NOW + BACKOFF_BASE_MS, 10)).toHaveLength(1);
    });
  });

  describe('failure handling', () => {
    it('backs off with a growing delay and records the error', async () => {
      const entry = await enqueueUpdate('evt-1', { n: 1 });

      const first = await repo.markFailed(entry.id, 'HTTP 500', { random: noJitter });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.attempts).toBe(1);
      expect(first.value.status).toBe('pending');
      expect(first.value.lastError).toBe('HTTP 500');
      expect(first.value.nextAttemptAt).toBe(NOW + BACKOFF_BASE_MS);

      const second = await repo.markFailed(entry.id, 'HTTP 500', { random: noJitter });
      if (!second.ok) throw new Error('expected ok');
      expect(second.value.attempts).toBe(2);
      expect(second.value.nextAttemptAt).toBe(NOW + BACKOFF_BASE_MS * 2);
    });

    it('gives up permanently after the attempt ceiling', async () => {
      const entry = await enqueueUpdate('evt-1', { n: 1 });
      for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) {
        await repo.markFailed(entry.id, `attempt ${i}`, { random: noJitter });
      }

      const stored = await repo.getById(entry.id);
      expect(stored?.attempts).toBe(MAX_SYNC_ATTEMPTS);
      expect(stored?.status).toBe('failed');
      expect(await repo.claimReady(NOW + BACKOFF_MAX_MS * 10, 10)).toEqual([]);
      expect(await repo.counts()).toEqual({ pending: 0, inFlight: 0, failed: 1 });
    });

    it('re-queues everything that failed permanently', async () => {
      const entry = await enqueueUpdate('evt-1', { n: 1 });
      for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) {
        await repo.markFailed(entry.id, 'nope', { random: noJitter });
      }

      expect(await repo.retryFailed()).toBe(1);
      const stored = await repo.getById(entry.id);
      expect(stored?.status).toBe('pending');
      expect(stored?.attempts).toBe(0);
      expect(stored?.lastError).toBeNull();
    });

    it('reports not_found for an unknown id', async () => {
      const missing = await repo.markFailed('nope', 'x');
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(missing.error.code).toBe('not_found');
    });
  });

  it('releases in_flight rows abandoned by a crashed worker', async () => {
    await enqueueUpdate('evt-1', { n: 1 });
    await enqueueUpdate('evt-2', { n: 2 });
    await repo.claimReady(NOW, 10);

    const staleAfter = 5 * 60_000;
    expect(await repo.releaseStale(NOW + staleAfter - 1, staleAfter)).toBe(0);
    expect(await repo.releaseStale(NOW + staleAfter, staleAfter)).toBe(2);

    const counts = await repo.counts();
    expect(counts).toEqual({ pending: 2, inFlight: 0, failed: 0 });
    expect(await repo.claimReady(NOW + staleAfter, 10)).toHaveLength(2);
  });

  it('leaves a freshly claimed row alone when releasing stale work', async () => {
    await enqueueUpdate('evt-1', { n: 1 });
    await repo.claimReady(NOW, 10);
    expect(await repo.releaseStale(NOW + 1000, 60_000)).toBe(0);
    expect((await repo.counts()).inFlight).toBe(1);
  });

  it('counts each status for the syncing badge', async () => {
    const a = await enqueueUpdate('evt-1', { n: 1 });
    await enqueueUpdate('evt-2', { n: 2 });
    const c = await enqueueUpdate('evt-3', { n: 3 });

    await repo.claimReady(NOW, 1);
    for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) {
      await repo.markFailed(c.id, 'nope', { random: noJitter });
    }

    expect(await repo.counts()).toEqual({ pending: 1, inFlight: 1, failed: 1 });
    await repo.markDone(a.id);
    expect(await repo.counts()).toEqual({ pending: 1, inFlight: 0, failed: 1 });
  });

  it('purges done rows older than the cutoff', async () => {
    const a = await enqueueUpdate('evt-1', { n: 1 });
    const b = await enqueueUpdate('evt-2', { n: 2 });
    await repo.markDone(a.id);
    await repo.markDone(b.id);

    expect(await repo.purgeDone(NOW)).toBe(0);
    expect(await repo.purgeDone(NOW + 1)).toBe(2);
    expect(await repo.getById(a.id)).toBeNull();
  });

  it('never purges work that has not been done', async () => {
    const entry = await enqueueUpdate('evt-1', { n: 1 });
    expect(await repo.purgeDone(NOW + 10_000)).toBe(0);
    expect(await repo.getById(entry.id)).not.toBeNull();
  });

  it('survives a payload that is not valid JSON', async () => {
    const entry = await enqueueUpdate('evt-1', { n: 1 });
    t.client.runSync('UPDATE sync_queue SET payload = ? WHERE id = ?', ['{oops', entry.id]);
    const stored = await repo.getById(entry.id);
    expect(decodePayload(stored!)).toBeNull();
  });
});
