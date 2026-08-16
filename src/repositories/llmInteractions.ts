/**
 * The assistant's own record of every turn — and the only reader `llm_interactions` has ever had.
 *
 * The table has been written on every utterance since the orchestrator was
 * built and read by nothing, which made it the one part of this app the user
 * could not check. Ridik keeps no audio: the transcript in this table *is* the
 * record of what was said, so a mis-heard word is only ever recoverable from
 * here. That is also what makes the table a privacy surface rather than a log —
 * it is the user's own words, and `clear()` has to really clear.
 *
 * Pure, like every repository: the developer screen wants percentiles and the
 * history screen wants rows, and both are answerable in SQLite against a real
 * database under plain Node.
 */
import { desc, eq, isNotNull, sql, type SQL } from 'drizzle-orm';

import type { RidikDatabase } from '@/db/migrator';
import { llmInteractions, type LlmInteraction } from '@/db/schema';

export type InteractionStatus = LlmInteraction['status'];

/**
 * One tool call, exactly as `src/llm/orchestrator.ts` wrote it.
 *
 * The column is a JSON array written by that one call site, in snake_case,
 * with two optional members. It is decoded defensively rather than parsed with
 * a schema because an audit row is evidence: a shape this app no longer writes
 * must still render whatever of it can be read, not vanish because one field
 * moved.
 */
export type InteractionAction = {
  toolName: string;
  /** What the model actually asked for — the difference between a mishearing and a bug. */
  parameters: Record<string, unknown> | null;
  ok: boolean;
  summary: string | null;
  /** The `AppErrorCode` the executor came back with, when it failed. */
  error: string | null;
  /** The question asked instead of acting, when the match was ambiguous. */
  asked: string | null;
};

/** A row with its `actions` column decoded. */
export type Interaction = LlmInteraction & { parsedActions: InteractionAction[] };

export type ModelTally = { model: string; turns: number };

/**
 * What the whole trail says about itself.
 *
 * `latencyMs` is written on every turn and has never had a reader, a target or
 * an alert. A mean would be useless here — one cold start or one repair ladder
 * drags it somewhere no turn ever was — so this reports the middle turn and the
 * bad one.
 */
export type InteractionStats = {
  total: number;
  ok: number;
  clarify: number;
  errors: number;
  /** Turns that recorded a latency at all; the percentiles are over these. */
  timed: number;
  /** Nearest-rank, so both are latencies that a real turn actually took. */
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  /** Tool calls per utterance, mean, to two decimals. Null on an empty trail. */
  actionsPerTurn: number | null;
  /** Busiest first. Renaming a model mid-history shows up as two rows, correctly. */
  models: ModelTally[];
  oldestAt: number | null;
  newestAt: number | null;
};

/**
 * How many turns back a latency read-out looks by default.
 *
 * `stats()` answers for the whole trail, which is the right unit for a history
 * header and the wrong one for the only question worth asking of a latency:
 * *is it slower than it was?* A thousand fast turns bury the hundred slow ones
 * that came after them, and a lifetime median moves so little that a doubling
 * of the real reply time barely shows. So the diagnostics read-out is a window.
 */
export const LATENCY_WINDOW = 100;

/**
 * What the slow tail of a spoken turn is held to.
 *
 * The tail rather than the middle, because the tail is what gets felt: a median
 * of a second with one turn in twenty taking eight is an assistant people stop
 * trusting, and the median never says so. Four seconds is roughly where a
 * spoken reply stops reading as an answer and starts reading as the app having
 * missed what was said — past that, people repeat themselves, which costs a
 * second request and usually a second mistake.
 *
 * A number nothing enforces. It exists so the read-out can say whether what it
 * shows is good, which is the difference between an instrument and a decoration.
 */
export const LATENCY_TARGET_P95_MS = 4_000;

/**
 * What the recent turns took, in the two figures that are not a lie.
 *
 * Nearest-rank, so both are durations a real turn actually had. A mean is
 * useless here: one cold start or one repair ladder drags it somewhere no turn
 * ever was.
 */
export type LatencySummary = {
  /** The window that was asked for, in turns. */
  window: number;
  /** Turns inside it — fewer than `window` on a young install. */
  turns: number;
  /** Of those, the ones that recorded a latency. The percentiles are over these. */
  timed: number;
  medianMs: number | null;
  p95Ms: number | null;
  slowestMs: number | null;
  /**
   * Whether `p95Ms` clears `LATENCY_TARGET_P95_MS`. Null when nothing in the
   * window was timed — "we did not measure" must never render as "fine".
   */
  withinTarget: boolean | null;
};

export type LatencyOptions = {
  /** Turns to look back over. Defaults to `LATENCY_WINDOW`. */
  window?: number;
};

export type ListInteractionsOptions = {
  /** Newest-first page size. Defaults to 50. */
  limit?: number;
  /** Exclusive upper bound on `createdAt`, for paging further back. */
  before?: number;
  status?: InteractionStatus;
};

const DEFAULT_LIMIT = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readAction(raw: Record<string, unknown>): InteractionAction {
  return {
    toolName: asString(raw.tool_name) ?? asString(raw.toolName) ?? 'unknown',
    parameters: isRecord(raw.parameters) ? raw.parameters : null,
    // Absent reads as failed rather than as succeeded: an audit trail that
    // guesses in the app's favour is worse than one that says nothing.
    ok: raw.ok === true,
    summary: asString(raw.summary),
    error: asString(raw.error),
    asked: asString(raw.asked),
  };
}

/** Never throws. A row whose `actions` cannot be read still has a transcript worth showing. */
export function parseActions(raw: string | null): InteractionAction[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecord).map(readAction) : [];
  } catch {
    return [];
  }
}

function decorate(row: LlmInteraction): Interaction {
  return { ...row, parsedActions: parseActions(row.actions) };
}

/** SQLite answers a percentile over an empty population as NULL; keep that. */
function nullable(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function createLlmInteractionsRepository(db: RidikDatabase) {
  /**
   * Every latency that was recorded, as a derived table.
   *
   * Written once and interpolated twice so the value and the offset that picks
   * it can never disagree about which rows are in the population.
   */
  const timed = sql`select ${llmInteractions.latencyMs} as ms from ${llmInteractions} where ${llmInteractions.latencyMs} is not null`;

  /**
   * The same population, cut to the most recent `window` *turns*.
   *
   * The window is applied before the null filter and not after it, so "the last
   * hundred turns" means turns. Cutting the timed rows instead would quietly
   * reach further and further back the more turns went untimed, and the read-out
   * would say "lately" about a week that had nothing to do with lately.
   *
   * `window` is written into the statement for the same reason the percentile
   * below is: it is an integer here and a double once bound, and SQLite will not
   * take a real as a LIMIT. It never comes from the user.
   */
  const recentlyTimed = (window: number) => sql`
    select ms from (
      select ${llmInteractions.latencyMs} as ms
      from ${llmInteractions}
      order by ${llmInteractions.createdAt} desc, rowid desc
      limit ${sql.raw(String(Math.trunc(window)))}
    ) where ms is not null`;

  /**
   * Nearest-rank percentile over a population, in integer arithmetic.
   *
   * `(n * p + 99) / 100` is `ceil(n * p / 100)` with SQLite's integer division,
   * which avoids both a float and `ceil()` — the latter needs
   * SQLITE_ENABLE_MATH_FUNCTIONS and this app ships to whatever the OS linked.
   *
   * The percentile is written into the statement rather than bound, and that is
   * load-bearing: a bound `50` arrives as a *double*, which turns the whole
   * expression real, and an OFFSET that is not an integer is a bare "datatype
   * mismatch" from SQLite. It is a literal in this file, never user input.
   *
   * The population is passed in and interpolated twice, so the value and the
   * offset that picks it can never disagree about which rows are in it.
   */
  const nearestRank = (percentile: number, population: SQL) => {
    const p = sql.raw(String(Math.trunc(percentile)));
    return sql<number | null>`(
      select ms from (${population}) order by ms
      limit 1 offset (select max(0, (count(*) * ${p} + 99) / 100 - 1) from (${population}))
    )`;
  };

  /**
   * Newest first, and stable when several turns share a millisecond — which
   * every turn does under a frozen clock, and two can under a real one.
   * `rowid` is insertion order; the table has a TEXT primary key, so it has one.
   */
  const newestFirst = [desc(llmInteractions.createdAt), sql`rowid desc`];

  async function listRecent(options: ListInteractionsOptions = {}): Promise<Interaction[]> {
    const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT));
    const filters = [
      ...(options.before === undefined
        ? []
        : [sql`${llmInteractions.createdAt} < ${options.before}`]),
      ...(options.status ? [eq(llmInteractions.status, options.status)] : []),
    ];

    const rows = await db
      .select()
      .from(llmInteractions)
      .where(filters.length > 0 ? sql.join(filters, sql` and `) : undefined)
      .orderBy(...newestFirst)
      .limit(limit);

    return rows.map(decorate);
  }

  async function getById(id: string): Promise<Interaction | null> {
    const [row] = await db
      .select()
      .from(llmInteractions)
      .where(eq(llmInteractions.id, id))
      .limit(1);
    return row ? decorate(row) : null;
  }

  async function stats(): Promise<InteractionStats> {
    // One statement rather than nine: this is a header, and the screen under it
    // is already fetching a page of rows.
    const [row] = await db
      .select({
        total: sql<number>`(select count(*) from ${llmInteractions})`,
        ok: sql<number>`(select count(*) from ${llmInteractions} where ${llmInteractions.status} = 'ok')`,
        clarify: sql<number>`(select count(*) from ${llmInteractions} where ${llmInteractions.status} = 'clarify')`,
        errors: sql<number>`(select count(*) from ${llmInteractions} where ${llmInteractions.status} = 'error')`,
        timed: sql<number>`(select count(*) from (${timed}))`,
        median: nearestRank(50, timed),
        p95: nearestRank(95, timed),
        // `json_array_length` answers 0 for anything that is not an array, and
        // `json_valid` keeps a half-written row from taking the whole header
        // down with it.
        actions: sql<number>`(
          select coalesce(sum(json_array_length(${llmInteractions.actions})), 0)
          from ${llmInteractions}
          where json_valid(${llmInteractions.actions})
        )`,
        oldestAt: sql<number | null>`(select min(${llmInteractions.createdAt}) from ${llmInteractions})`,
        newestAt: sql<number | null>`(select max(${llmInteractions.createdAt}) from ${llmInteractions})`,
      })
      .from(sql`(select 1)`);

    const models = await db
      .select({ model: llmInteractions.model, turns: sql<number>`count(*)`.mapWith(Number) })
      .from(llmInteractions)
      .where(isNotNull(llmInteractions.model))
      .groupBy(llmInteractions.model)
      .orderBy(sql`count(*) desc`, sql`min(${llmInteractions.model}) asc`);

    const total = Number(row?.total ?? 0);
    const actions = Number(row?.actions ?? 0);

    return {
      total,
      ok: Number(row?.ok ?? 0),
      clarify: Number(row?.clarify ?? 0),
      errors: Number(row?.errors ?? 0),
      timed: Number(row?.timed ?? 0),
      medianLatencyMs: nullable(row?.median),
      p95LatencyMs: nullable(row?.p95),
      actionsPerTurn: total === 0 ? null : Math.round((actions / total) * 100) / 100,
      models: models
        .filter((entry): entry is { model: string; turns: number } => entry.model !== null)
        .map((entry) => ({ model: entry.model, turns: Number(entry.turns) })),
      oldestAt: nullable(row?.oldestAt),
      newestAt: nullable(row?.newestAt),
    };
  }

  /**
   * How slow the assistant has been lately.
   *
   * `latency_ms` has been written on every turn since the orchestrator was
   * built, and until the history screen there was nothing that read it — which
   * meant the app had a number for "did that feel slow?" and no way to answer
   * the question. This is that number in the shape a diagnostic wants: a recent
   * window, the middle turn, the slow tail, and whether the tail clears the one
   * figure it is held to.
   *
   * Pure SQL and one statement, like `stats()`, because it runs behind a screen
   * that is already fetching four other things.
   */
  async function latency(options: LatencyOptions = {}): Promise<LatencySummary> {
    const window = Math.max(1, Math.trunc(options.window ?? LATENCY_WINDOW));
    const population = recentlyTimed(window);

    const [row] = await db
      .select({
        total: sql<number>`(select count(*) from ${llmInteractions})`,
        timed: sql<number>`(select count(*) from (${population}))`,
        median: nearestRank(50, population),
        p95: nearestRank(95, population),
        slowest: sql<number | null>`(select max(ms) from (${population}))`,
      })
      .from(sql`(select 1)`);

    const p95Ms = nullable(row?.p95);

    return {
      window,
      turns: Math.min(window, Number(row?.total ?? 0)),
      timed: Number(row?.timed ?? 0),
      medianMs: nullable(row?.median),
      p95Ms,
      slowestMs: nullable(row?.slowest),
      withinTarget: p95Ms === null ? null : p95Ms <= LATENCY_TARGET_P95_MS,
    };
  }

  /** Forgets one turn. False when there was nothing under that id. */
  async function remove(id: string): Promise<boolean> {
    // The id alone: the caller wants to know whether anything went, and
    // decoding a row's JSON on the way to deleting it is work for nobody.
    const [existing] = await db
      .select({ id: llmInteractions.id })
      .from(llmInteractions)
      .where(eq(llmInteractions.id, id))
      .limit(1);
    if (!existing) return false;
    await db.delete(llmInteractions).where(eq(llmInteractions.id, id));
    return true;
  }

  /**
   * Forgets everything, and returns how many turns that was.
   *
   * Counted before the delete rather than after, because the number is what the
   * receipt says — "1,204 turns deleted" is the only confirmation the user gets
   * that the button did what it claimed.
   */
  async function clear(): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(llmInteractions);
    const total = Number(row?.n ?? 0);
    if (total > 0) await db.delete(llmInteractions);
    return total;
  }

  return { listRecent, getById, stats, latency, remove, clear };
}

export type LlmInteractionsRepository = ReturnType<typeof createLlmInteractionsRepository>;

export type { LlmInteraction };
