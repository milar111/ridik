/**
 * Write serialisation for the calendar/sync/settings/focus repositories.
 *
 * There is a single SQLite connection and every repository method awaits
 * between statements, so two overlapping calls interleave. That breaks three
 * ways: a second `BEGIN` inside an open transaction throws, the `ROLLBACK` that
 * follows discards the *other* call's writes, and a read-modify-write (the
 * outbox dedupe, a backoff bump) reads state a sibling call is about to
 * overwrite. Queuing every write per connection keeps each one whole.
 *
 * The queue is keyed on the client rather than held per repository so a
 * `settings.setMany` and a `syncQueue.claimReady` — different repositories, one
 * connection — cannot open transactions inside each other.
 */
import type { RidikDatabase } from '@/db/migrator';

const queues = new WeakMap<object, Promise<unknown>>();

/** Runs `job` after every write already queued on this connection. */
export function serialised<T>(db: RidikDatabase, job: () => Promise<T>): Promise<T> {
  const tail = queues.get(db.$client) ?? Promise.resolve();
  const next = tail.then(job);
  // The queue has to outlive a rejected job; the caller still sees the throw.
  queues.set(
    db.$client,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Raw transaction control rather than `db.transaction()`: these bodies are
 * async, and the sync-mode callback Drizzle expects would commit before an
 * awaited statement had run.
 */
export function transactional<T>(db: RidikDatabase, run: () => Promise<T>): Promise<T> {
  return serialised(db, async () => {
    db.$client.execSync('BEGIN');
    try {
      const value = await run();
      db.$client.execSync('COMMIT');
      return value;
    } catch (error) {
      db.$client.execSync('ROLLBACK');
      throw error;
    }
  });
}
