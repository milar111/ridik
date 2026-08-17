/**
 * Where the counter lives.
 *
 * The handler needs two operations and does not care how they are stored. What
 * it does care about — and what a naive implementation gets wrong — is that
 * `increment` must be **atomic**. Two requests from the same person arriving in
 * the same millisecond on two different instances of a serverless function must
 * add two, not one. A read-modify-write in application code cannot promise that,
 * which is why neither implementation here does one.
 *
 * The window is a UTC day. Not the user's local day: a device clock is something
 * the user can set, and the whole point of this file is being the count they
 * cannot edit. `src/services/billing/allowance.ts` says the same thing about the
 * in-app meter, which ratchets for exactly this reason.
 */
import type { Quota } from './interpret';

/** `2026-08-17` in UTC — the partition key for every implementation here. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------- in memory -- */

/**
 * For tests and for running the handler on your laptop. NOT for deployment:
 * every serverless instance would keep its own count, so the real limit becomes
 * `dailyLimit × however many instances the platform decided to start`.
 */
export function createMemoryQuota(now: () => Date = () => new Date()): Quota & {
  tokens(userId: string): { input: number; output: number };
} {
  const requests = new Map<string, number>();
  const tokens = new Map<string, { input: number; output: number }>();
  const key = (userId: string) => `${utcDay(now())}:${userId}`;

  return {
    async used(userId) {
      return requests.get(key(userId)) ?? 0;
    },
    async increment(userId, used) {
      const k = key(userId);
      requests.set(k, (requests.get(k) ?? 0) + 1);
      const totals = tokens.get(k) ?? { input: 0, output: 0 };
      tokens.set(k, { input: totals.input + used.input, output: totals.output + used.output });
    },
    tokens(userId) {
      return tokens.get(key(userId)) ?? { input: 0, output: 0 };
    },
  };
}

/* -------------------------------------------------------------- postgres -- */

/**
 * The minimal thing that can hold `sql` — node-postgres, Neon's serverless
 * driver, Supabase's, or a two-line wrapper round anything else. Typed here so
 * this file needs no dependency of its own.
 */
export type SqlQuery = <Row>(text: string, values: unknown[]) => Promise<Row[]>;

/**
 * Run once. `day` is part of the primary key rather than a row that gets reset,
 * so there is no cron job to forget and yesterday's numbers stay readable.
 */
export const QUOTA_SCHEMA = `
create table if not exists assistant_usage (
  user_id       text        not null,
  day           date        not null,
  requests      integer     not null default 0,
  input_tokens  bigint      not null default 0,
  output_tokens bigint      not null default 0,
  primary key (user_id, day)
);
`;

/**
 * Postgres, and atomic because the database does the addition.
 *
 * `on conflict do update` with `assistant_usage.requests + 1` is a single
 * statement: two concurrent calls serialise on the row lock and both land. The
 * version that loses a request under load is
 * `select` → `+1` → `update`, which is the obvious way to write it.
 */
export function createPostgresQuota(sql: SqlQuery, now: () => Date = () => new Date()): Quota {
  return {
    async used(userId) {
      const rows = await sql<{ requests: number }>(
        'select requests from assistant_usage where user_id = $1 and day = $2',
        [userId, utcDay(now())],
      );
      return rows[0]?.requests ?? 0;
    },
    async increment(userId, used) {
      await sql(
        `insert into assistant_usage (user_id, day, requests, input_tokens, output_tokens)
         values ($1, $2, 1, $3, $4)
         on conflict (user_id, day) do update set
           requests      = assistant_usage.requests + 1,
           input_tokens  = assistant_usage.input_tokens + excluded.input_tokens,
           output_tokens = assistant_usage.output_tokens + excluded.output_tokens`,
        [userId, utcDay(now()), used.input, used.output],
      );
    },
  };
}

/* ----------------------------------------------------------------- redis -- */

/**
 * The other atomic option, if you already run Redis (Upstash included).
 *
 * `INCR` returns the value after incrementing, and `EXPIRE` on a key that
 * already has a TTL is a no-op, so there is no window where the key outlives its
 * day. Passed as two functions rather than a client so this file stays
 * dependency-free.
 */
export type RedisLike = {
  incrBy(key: string, by: number): Promise<number>;
  get(key: string): Promise<string | null>;
  expire(key: string, seconds: number): Promise<unknown>;
};

export function createRedisQuota(redis: RedisLike, now: () => Date = () => new Date()): Quota {
  const at = () => now();
  const key = (userId: string, kind: string) => `assistant:${utcDay(at())}:${userId}:${kind}`;

  return {
    async used(userId) {
      const value = await redis.get(key(userId, 'requests'));
      const count = value === null ? 0 : Number.parseInt(value, 10);
      return Number.isFinite(count) ? count : 0;
    },
    async increment(userId, used) {
      const ttl = secondsUntilUtcMidnight(at());
      await Promise.all([
        redis.incrBy(key(userId, 'requests'), 1).then(() => redis.expire(key(userId, 'requests'), ttl)),
        redis.incrBy(key(userId, 'input'), used.input).then(() => redis.expire(key(userId, 'input'), ttl)),
        redis
          .incrBy(key(userId, 'output'), used.output)
          .then(() => redis.expire(key(userId, 'output'), ttl)),
      ]);
    },
  };
}

function secondsUntilUtcMidnight(at: Date): number {
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return Math.max(1, Math.round((midnight - at.getTime()) / 1000));
}
