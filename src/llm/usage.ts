/**
 * The spend meter and the app's own cap.
 *
 * Google's project-level spend cap is the real backstop, but it lives in a
 * console the user has to remember to configure, it enforces on *estimated*
 * cost minutes later, and it cuts off the whole project rather than this app.
 * So Ridik also counts its own requests and refuses to make more once the day's
 * or month's ceiling is reached — at which point voice falls back to the
 * offline pattern matcher rather than going quiet.
 *
 * Counting requests, not dollars, is deliberate: a request cap is something a
 * person can reason about ("200 things I can say to it today"), and it holds
 * even if the provider changes its prices underneath us. The cost estimate is
 * shown alongside so the number means something, but it is never the gate.
 */
import { and, gte, lte, sql } from 'drizzle-orm';

import { now } from '@/core/clock';
import { currentZone, localDateOf, monthRange } from '@/core/time';
import { fail, ok, type Result } from '@/core/result';
import type { RidikDatabase } from '@/db/migrator';
import { llmUsage } from '@/db/schema';

/** Per-million-token prices, in micro-units of the provider's currency. */
export type ModelRate = { inputPerMillion: number; outputPerMillion: number };

/**
 * Published list prices as of August 2026, in USD per million tokens. Only used
 * to render an estimate — nothing depends on these being current, and a model
 * we do not recognise simply reports no cost rather than a wrong one.
 */
export const MODEL_RATES: Record<string, ModelRate> = {
  'gemini-flash-latest': { inputPerMillion: 0.25, outputPerMillion: 1.5 },
  'gemini-3-flash': { inputPerMillion: 0.25, outputPerMillion: 1.5 },
  'gemini-3-flash-preview': { inputPerMillion: 0.25, outputPerMillion: 1.5 },
  'gemini-3.6-flash': { inputPerMillion: 1.5, outputPerMillion: 7.5 },
  'gemini-3.1-flash-lite': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
};

export function estimateCostMicros(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = MODEL_RATES[model];
  if (!rate) return 0;
  const dollars =
    (inputTokens / 1_000_000) * rate.inputPerMillion +
    (outputTokens / 1_000_000) * rate.outputPerMillion;
  return Math.round(dollars * 1_000_000);
}

export type UsageWindow = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
};

export type UsageSnapshot = {
  today: UsageWindow;
  month: UsageWindow;
  dailyCap: number;
  monthlyCap: number;
  /** How many more calls are allowed right now. */
  remainingToday: number;
  remainingThisMonth: number;
};

export type UsageCaps = { daily: number; monthly: number };

const EMPTY: UsageWindow = { requests: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 };

export function createUsageMeter(db: RidikDatabase) {
  async function windowFor(from: string, to: string): Promise<UsageWindow> {
    const rows = await db
      .select({
        requests: sql<number>`coalesce(sum(${llmUsage.requests}), 0)`,
        inputTokens: sql<number>`coalesce(sum(${llmUsage.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${llmUsage.outputTokens}), 0)`,
        costMicros: sql<number>`coalesce(sum(${llmUsage.costMicros}), 0)`,
      })
      .from(llmUsage)
      .where(and(gte(llmUsage.localDate, from), lte(llmUsage.localDate, to)));
    return rows[0] ?? EMPTY;
  }

  async function snapshot(caps: UsageCaps, zone = currentZone()): Promise<UsageSnapshot> {
    const at = now();
    const today = localDateOf(at, zone);
    const { start, end } = monthRange(at, zone);
    const [todayWindow, monthWindow] = await Promise.all([
      windowFor(today, today),
      // `end` is exclusive, so step back an instant for the inclusive last day.
      windowFor(localDateOf(start, zone), localDateOf(end - 1, zone)),
    ]);
    return {
      today: todayWindow,
      month: monthWindow,
      dailyCap: caps.daily,
      monthlyCap: caps.monthly,
      remainingToday: Math.max(0, caps.daily - todayWindow.requests),
      remainingThisMonth: Math.max(0, caps.monthly - monthWindow.requests),
    };
  }

  /**
   * Nothing is reserved up front: a crash between check and record would
   * otherwise permanently burn a slot. At one request per utterance the race
   * is not worth the complexity — worst case the cap is exceeded by one.
   */
  async function check(caps: UsageCaps, zone = currentZone()): Promise<Result<UsageSnapshot>> {
    const state = await snapshot(caps, zone);
    if (caps.daily > 0 && state.remainingToday <= 0) {
      return fail(
        'rate_limited',
        `You've used today's ${caps.daily} assistant requests. It resets at midnight — until then, commands fall back to simple pattern matching.`,
        { details: state },
      );
    }
    if (caps.monthly > 0 && state.remainingThisMonth <= 0) {
      return fail(
        'rate_limited',
        `You've used this month's ${caps.monthly} assistant requests. Raise the cap in Settings if you need more.`,
        { details: state },
      );
    }
    return ok(state);
  }

  async function record(input: {
    model: string;
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    zone?: string;
  }): Promise<void> {
    const at = now();
    const localDate = localDateOf(at, input.zone ?? currentZone());
    const inputTokens = Math.max(0, Math.round(input.inputTokens ?? 0));
    const outputTokens = Math.max(0, Math.round(input.outputTokens ?? 0));
    const costMicros = estimateCostMicros(input.model, inputTokens, outputTokens);

    await db
      .insert(llmUsage)
      .values({ localDate, requests: 1, inputTokens, outputTokens, costMicros, updatedAt: at })
      .onConflictDoUpdate({
        target: llmUsage.localDate,
        set: {
          requests: sql`${llmUsage.requests} + 1`,
          inputTokens: sql`${llmUsage.inputTokens} + ${inputTokens}`,
          outputTokens: sql`${llmUsage.outputTokens} + ${outputTokens}`,
          costMicros: sql`${llmUsage.costMicros} + ${costMicros}`,
          updatedAt: at,
        },
      });
  }

  /** Test/maintenance hook, and the "reset my counter" button in Settings. */
  async function clear(): Promise<void> {
    await db.delete(llmUsage);
  }

  return { snapshot, check, record, clear };
}

export type UsageMeter = ReturnType<typeof createUsageMeter>;

/** "$0.42" from micro-units, for the Settings row. */
export function formatCostMicros(micros: number): string {
  if (micros <= 0) return '$0.00';
  return `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 4 : 2)}`;
}
