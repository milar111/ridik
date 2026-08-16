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
import { desc, eq, isNotNull, sql } from 'drizzle-orm';

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

export function createLlmInteractionsRepository(db: RidikDatabase) {
  /**
   * Every latency that was recorded, as a derived table.
   *
   * Written once and interpolated twice so the value and the offset that picks
   * it can never disagree about which rows are in the population.
   */
  const timed = sql`select ${llmInteractions.latencyMs} as ms from ${llmInteractions} where ${llmInteractions.latencyMs} is not null`;

  /**
   * Nearest-rank percentile, in integer arithmetic.
   *
   * `(n * p + 99) / 100` is `ceil(n * p / 100)` with SQLite's integer division,
   * which avoids both a float and `ceil()` — the latter needs
   * SQLITE_ENABLE_MATH_FUNCTIONS and this app ships to whatever the OS linked.
   *
   * The percentile is written into the statement rather than bound, and that is
   * load-bearing: a bound `50` arrives as a *double*, which turns the whole
   * expression real, and an OFFSET that is not an integer is a bare "datatype
   * mismatch" from SQLite. It is a literal in this file, never user input.
   */
  const nearestRank = (percentile: number) => {
    const p = sql.raw(String(Math.trunc(percentile)));
    return sql<number | null>`(
      select ms from (${timed}) order by ms
      limit 1 offset (select max(0, (count(*) * ${p} + 99) / 100 - 1) from (${timed}))
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
        median: nearestRank(50),
        p95: nearestRank(95),
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
    const nullable = (value: number | null | undefined) =>
      value === null || value === undefined ? null : Number(value);

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

  return { listRecent, getById, stats, remove, clear };
}

export type LlmInteractionsRepository = ReturnType<typeof createLlmInteractionsRepository>;

export type { LlmInteraction };
