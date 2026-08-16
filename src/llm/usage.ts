/**
 * The spend meter and the app's own cap.
 *
 * Google's project-level spend cap is the real backstop, but it lives in a
 * console the user has to remember to configure, it enforces on *estimated*
 * cost minutes later, and it cuts off the whole project rather than this app.
 * So Ridik also meters itself and refuses to call the model once the day's or
 * month's ceiling is reached — at which point voice falls back to the offline
 * pattern matcher rather than going quiet.
 *
 * A ceiling can be stated in three units, and the first one crossed stops the
 * turn:
 *
 *   requests    what a person can reason about ("200 things I can say to it
 *               today"), and it holds even if the provider changes its prices.
 *               This is the unit the developer sliders speak and the unit the
 *               Settings receipt shows.
 *   tokens      what the provider actually bills. A request is a poor proxy for
 *               spend: one call carrying a large context costs many times a
 *               short one and still counts as 1, so an allowance that has to be
 *               *protective* — the free trial in `services/billing/allowance.ts`,
 *               spending someone else's invoice — has to be able to say it in
 *               tokens.
 *   costMicros  money, for an operator who thinks in dollars rather than
 *               tokens and does not want to re-derive the cap when a price
 *               changes.
 *
 * Requests are known exactly before a call; tokens and cost are not, so those
 * two are **estimated before and reconciled after** — see `projectTurn` for
 * where the estimate comes from and `check` for which way it errs.
 *
 * This module counts; it does not decide who is entitled to spend. That is
 * `resolveAssistantBudget()`, which hands the caps down in this file's own
 * vocabulary.
 */
import { and, gte, lte, sql } from 'drizzle-orm';

import { now } from '@/core/clock';
import { currentZone, localDateOf } from '@/core/time';
import { fail, ok, type Result } from '@/core/result';
import type { RidikDatabase } from '@/db/migrator';
import { llmUsage } from '@/db/schema';

/** Per-million-token prices, in micro-units of the provider's currency. */
export type ModelRate = {
  inputPerMillion: number;
  outputPerMillion: number;
  /**
   * What an input token costs when the provider served it from a prompt cache.
   * Absent means "priced like any other input token", which is the safe
   * assumption for a provider that does not cache — never a discount we made up.
   */
  cachedInputPerMillion?: number;
};

/**
 * Published list prices, USD per million tokens, checked against
 * ai.google.dev/gemini-api/docs/pricing on 16 August 2026.
 *
 * The docblock here used to say "nothing depends on these being current". That
 * stopped being true the day a cost cap started reading `costMicros`: these
 * numbers now decide when a user is cut off and when the operator's budget is
 * declared spent. Three of the five rows were wrong when that changed, all in
 * the dangerous direction — `gemini-3.1-flash-lite` carried Gemini *2.5*
 * Flash-Lite's prices, understating input 2.5x and output 3.75x, so a cap set
 * in dollars let through two and a half times the spend it was configured for.
 *
 * The Gemini family prices a cached input token at a tenth of a fresh one, so
 * `cachedInputPerMillion` is one tenth of the row's own input rate and has to be
 * moved with it if that rate is ever corrected. The discount is only applied to
 * tokens the provider itself said were cached; see `estimateCostMicros`.
 *
 * Where a rate is time-limited, the LATER and higher rate is the one recorded.
 * A promotional price that lapses would otherwise silently double every
 * estimate on a date nobody is watching, and for a spend cap the safe error is
 * to overstate: cutting a user off slightly early is recoverable, a 2x overrun
 * on somebody else's invoice is not.
 */
export const MODEL_RATES: Record<string, ModelRate> = {
  // Flash. 3.7 and 3.6 are promotional at 0.75/3.75 until 31 Dec 2026; the
  // January rate is recorded instead, for the reason in the docblock.
  'gemini-3.7-flash': { inputPerMillion: 1.5, outputPerMillion: 7.5, cachedInputPerMillion: 0.15 },
  'gemini-3.6-flash': { inputPerMillion: 1.5, outputPerMillion: 7.5, cachedInputPerMillion: 0.15 },
  'gemini-3.5-flash': { inputPerMillion: 1.5, outputPerMillion: 9.0, cachedInputPerMillion: 0.15 },
  'gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5, cachedInputPerMillion: 0.03 },

  // Flash-Lite.
  'gemini-3.5-flash-lite': { inputPerMillion: 0.3, outputPerMillion: 2.5, cachedInputPerMillion: 0.03 },
  'gemini-3.1-flash-lite': { inputPerMillion: 0.25, outputPerMillion: 1.5, cachedInputPerMillion: 0.025 },
  'gemini-2.5-flash-lite': { inputPerMillion: 0.1, outputPerMillion: 0.4, cachedInputPerMillion: 0.01 },
};

/**
 * What an unrecognised model is billed at.
 *
 * `estimateCostMicros` used to return 0 here, which reads as prudent and is the
 * opposite: a model name this table has not been taught — a rename upstream, a
 * value typed into the developer screen, or an alias resolving somewhere new —
 * would have billed as FREE, and a spend cap counting free requests never
 * trips at all. Zero is the one answer that cannot be right.
 *
 * The most expensive row instead. An estimate that is too high shows the user a
 * cost they did not incur and trips a cap early, both of which are visible and
 * recoverable; one that is too low is invisible until the invoice.
 */
export const FALLBACK_RATE: ModelRate = {
  inputPerMillion: 1.5,
  outputPerMillion: 9.0,
  cachedInputPerMillion: 0.15,
};

/**
 * `DEFAULT_GEMINI_MODEL` is `gemini-flash-latest`, which Google does not price
 * on its own page — it is a moving alias over a family spanning $0.10 to $1.50
 * per million input tokens. It is deliberately absent from the table above so
 * that it takes `FALLBACK_RATE` rather than a number somebody guessed: pricing
 * an alias is pricing a value the vendor can change without a deploy.
 *
 * The fix is to pin an explicit version in `provider/gemini.ts`, which is a
 * product decision about which model answers the user rather than an accounting
 * one, and is left to whoever makes it.
 */

/**
 * `cachedTokens` is a *subset* of `inputTokens`, the way every provider reports
 * it, so the cheap tokens are subtracted from the full-price ones rather than
 * added alongside them. Getting this backwards is how a cache appears to make
 * requests more expensive.
 */
export function estimateCostMicros(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0,
): number {
  const rate = MODEL_RATES[model] ?? FALLBACK_RATE;
  const cached = Math.min(Math.max(0, cachedTokens), Math.max(0, inputTokens));
  const fresh = Math.max(0, inputTokens) - cached;
  const dollars =
    (fresh / 1_000_000) * rate.inputPerMillion +
    (cached / 1_000_000) * (rate.cachedInputPerMillion ?? rate.inputPerMillion) +
    (outputTokens / 1_000_000) * rate.outputPerMillion;
  return Math.round(dollars * 1_000_000);
}

/* -------------------------------------------------------------------- caps -- */

/**
 * A ceiling, stated explicitly.
 *
 * The point of the type is that "no ceiling" is a *value*, not a number that
 * arithmetic can arrive at. The developer settings have always used 0 to mean
 * "unlimited" and a slider, a hook and a Settings row all rely on that; an
 * entitlement allowance also comes through as 0 when the user has bought
 * nothing. Those two must never again be the same thing: `limitOf(0)` refuses
 * every request, and only `developerCap()` — used only for the developer
 * rows — turns a 0 into `UNLIMITED`.
 */
export type Cap =
  | { readonly kind: 'unlimited' }
  | { readonly kind: 'limit'; readonly value: number };

export const UNLIMITED: Cap = { kind: 'unlimited' };

/** An explicit ceiling. `limitOf(0)` allows nothing at all. */
export function limitOf(value: number): Cap {
  return { kind: 'limit', value: Math.max(0, Math.floor(value)) };
}

/**
 * The shipped developer-settings convention, and the only place it survives:
 * 0 in `llmDailyRequestCap` / `llmMonthlyRequestCap` means "no ceiling".
 *
 * Never use this to turn an entitlement allowance into a cap — that is the
 * exact confusion the `Cap` type exists to prevent.
 */
export function developerCap(value: number): Cap {
  return value > 0 ? limitOf(value) : UNLIMITED;
}

/** The lower of two ceilings. `UNLIMITED` loses to anything explicit. */
export function tighter(a: Cap, b: Cap): Cap {
  if (a.kind === 'unlimited') return b;
  if (b.kind === 'unlimited') return a;
  return a.value <= b.value ? a : b;
}

/** Plain number for a UI row: 0 for "no ceiling", matching the settings rows. */
function capNumber(cap: Cap): number {
  return cap.kind === 'unlimited' ? 0 : cap.value;
}

/**
 * What one window — a local day, or a local month — may draw. Every unit is
 * checked independently and the first one crossed stops the turn.
 */
export type WindowCaps = {
  /** Turns. Known exactly before the call: the next one costs 1. */
  requests: Cap;
  /** Input + output tokens together. Estimated before, reconciled after. */
  tokens: Cap;
  /** Micro-units of the provider's currency. Same estimate/reconcile. */
  costMicros: Cap;
};

/**
 * How a window's ceilings can be stated:
 *
 *   `200`                     the legacy request cap, carrying the developer
 *                             convention (0 = unlimited), so every existing
 *                             call site still means exactly what it did;
 *   `limitOf(200)`            a request cap where 0 is a real zero;
 *   `{ tokens: limitOf(1e6) }`  any mix of the three units. Anything not named
 *                             is unlimited.
 *
 * Anything enforcing an *entitlement* must use the `Cap` forms.
 */
export type CapsInput = number | Cap | Partial<WindowCaps>;

export type UsageCaps = { daily: CapsInput; monthly: CapsInput };

function resolveCaps(input: CapsInput): WindowCaps {
  if (typeof input === 'number') {
    return { requests: developerCap(input), tokens: UNLIMITED, costMicros: UNLIMITED };
  }
  if ('kind' in input) {
    return { requests: input, tokens: UNLIMITED, costMicros: UNLIMITED };
  }
  return {
    requests: input.requests ?? UNLIMITED,
    tokens: input.tokens ?? UNLIMITED,
    costMicros: input.costMicros ?? UNLIMITED,
  };
}

/* --------------------------------------------------------------- estimates -- */

/** What one turn is expected to draw, in the two units that cannot be counted. */
export type TurnEstimate = { tokens: number; costMicros: number };

/**
 * One turn with no history to go on. Re-measured against the shipped prompt on
 * 16 August 2026.
 *
 * Both halves moved, in opposite directions, and the old pair was wrong on
 * each. Input was 7,240 when the strict response schema was sent on every
 * call; `settings.llmSchemaRung` now defaults to the envelope, which took the
 * schema from ~4,626 tokens to ~323 and the turn to ~3,240. Output was 260 —
 * the visible reply only — but a thinking model also bills
 * `thoughtsTokenCount` at the output rate, and that was being discarded until
 * `provider/gemini.ts` learned to add it. Measured turns run nearer 600.
 *
 * This is only the cold-start guess: `estimateNextTurn` prefers the rolling
 * average of what this user's turns have actually drawn. But the guess is what
 * a fresh install is budgeted against, and it decides whether the very first
 * utterance of a free trial is waved through or refused — so being 2.2x high
 * on input over-charged the trial, and being 2.3x low on output under-charged
 * the part that costs six times more.
 */
export const TYPICAL_TURN = { inputTokens: 3_240, outputTokens: 600 } as const;

/** The same figure as one number, for anyone sizing a budget in tokens. */
export const TYPICAL_TURN_TOKENS = TYPICAL_TURN.inputTokens + TYPICAL_TURN.outputTokens;

/**
 * Characters per token, calibrated against this app's own prompt rather than
 * taken from a rule of thumb.
 *
 * The shipped system prompt plus the strict response schema is 26,670
 * characters and measures 7,240 input tokens, which is 3.68 — the generic
 * "about four" undercounts this content by nearly 9%, and every use of it here
 * is sizing a ceiling that protects somebody's invoice. Rounding down is the
 * safe direction: it over-estimates the token count.
 */
const CHARS_PER_TOKEN = 3.6;

/**
 * Roughly how many tokens a piece of text will bill as.
 *
 * Used to size a turn *before* it is sent, which is the only moment a ceiling
 * can still refuse it. Deliberately an over-estimate — see above — because the
 * cost of guessing high is one turn answered offline and the cost of guessing
 * low is an unbounded call.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Prices the fallback estimate when the caller does not name a model. */
const TYPICAL_MODEL = 'gemini-flash-latest';

function averageTurn(window: UsageWindow): TurnEstimate | null {
  if (window.requests <= 0) return null;
  return {
    tokens: Math.ceil((window.inputTokens + window.outputTokens) / window.requests),
    costMicros: Math.ceil(window.costMicros / window.requests),
  };
}

/**
 * What the next turn is likely to draw.
 *
 * The rolling average of what this user's turns have actually cost, computed
 * from sums `check` has already loaded — no extra query, and it follows the
 * prompt and the model as they change instead of trusting a constant that will
 * rot. Today and this month are both averaged and the *larger* wins, so a day
 * of long, context-heavy turns is not diluted by three cheap weeks.
 */
function projectTurn(today: UsageWindow, month: UsageWindow, model: string): TurnEstimate {
  const seen = [averageTurn(today), averageTurn(month)].filter((e): e is TurnEstimate => e !== null);
  if (seen.length === 0) {
    return {
      tokens: TYPICAL_TURN_TOKENS,
      costMicros: estimateCostMicros(model, TYPICAL_TURN.inputTokens, TYPICAL_TURN.outputTokens),
    };
  }
  return {
    tokens: Math.max(...seen.map((e) => e.tokens)),
    costMicros: Math.max(...seen.map((e) => e.costMicros)),
  };
}

/* ----------------------------------------------------------------- windows -- */

export type UsageWindow = {
  /** Utterances. What a plan is sold in and what the sliders are labelled in. */
  requests: number;
  /** Billable provider calls behind them — always >= `requests`. */
  calls: number;
  inputTokens: number;
  /**
   * Of `inputTokens`, the ones a prompt cache served. This is the only number
   * that can answer "is prompt caching doing anything?" after the fact — a hit
   * changes neither the request count nor the input count.
   */
  cachedTokens: number;
  outputTokens: number;
  costMicros: number;
};

export type UsageSnapshot = {
  today: UsageWindow;
  month: UsageWindow;
  /** The request ceilings as plain numbers, 0 for "no ceiling" — for the UI. */
  dailyCap: number;
  monthlyCap: number;
  /** How many more calls are allowed right now. */
  remainingToday: number;
  remainingThisMonth: number;
  /** Every ceiling, in every unit, after the caps have been resolved. */
  limits: { daily: WindowCaps; monthly: WindowCaps };
  /** What the next turn is projected to draw, i.e. what `check` gates on. */
  estimate: TurnEstimate;
};

/** Which window a breach happened in, and in which unit, for diagnostics. */
export type UsageBreach = {
  window: 'today' | 'month';
  unit: keyof WindowCaps;
  cap: number;
  used: number;
  projected: number;
};

export type CheckOptions = {
  zone?: string;
  /**
   * What this turn will draw, from a caller that can see something the rolling
   * average cannot — the length of the transcript it is about to send.
   *
   * A **floor**, not an override. The average describes turns already
   * recorded, so on a fresh install it is the built-in typical turn and a
   * megabyte of pasted text sails through it; but a user whose turns really do
   * cost more than this guess must keep the higher number. Partial: name one
   * unit and the other keeps the average.
   */
  estimate?: Partial<TurnEstimate>;
  /** Prices the fallback estimate before there is any history to average. */
  model?: string;
};

const EMPTY: UsageWindow = {
  requests: 0,
  calls: 0,
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  costMicros: 0,
};

const UNITS = ['requests', 'tokens', 'costMicros'] as const;

const USED: Record<keyof WindowCaps, (w: UsageWindow) => number> = {
  requests: (w) => w.requests,
  // Cached tokens are cheaper, not free, and they are already inside
  // `inputTokens`; a token ceiling counts what was drawn, and `costMicros` is
  // the unit that knows about the discount.
  tokens: (w) => w.inputTokens + w.outputTokens,
  costMicros: (w) => w.costMicros,
};

/**
 * The sentence the user hears. Never in tokens: "you have used 240,000 tokens"
 * is a number nobody can act on, and every one of these promises the offline
 * fallback so the message reads as a change of gear rather than a breakage.
 */
function breachMessage(window: 'today' | 'month', unit: keyof WindowCaps, cap: number): string {
  if (cap <= 0) {
    // Nothing was ever allowed here, so "you have used your 0 requests" is
    // nonsense. An explicit zero can only come from an allowance — the
    // developer rows can never produce one — and the honest sentence still
    // ends on the thing that does work.
    return (
      "You don't have any assistant requests right now. " +
      'Ridik still works — commands fall back to simple pattern matching.'
    );
  }
  const resets =
    window === 'today'
      ? 'It resets at midnight — until then, commands fall back to simple pattern matching.'
      : 'Until it resets, commands fall back to simple pattern matching.';
  if (unit === 'requests') {
    return window === 'today'
      ? `You've used today's ${cap} assistant requests. ${resets}`
      : // Not "raise the cap in Settings": the caps moved to the developer
        // screen, and on a store build the answer is a plan rather than a
        // slider. Saying where the control is when it is not there is worse
        // than saying nothing.
        `You've used this month's ${cap} assistant requests. Until the month turns over, commands fall back to simple pattern matching.`;
  }
  if (unit === 'costMicros') {
    return window === 'today'
      ? `You've used today's ${formatCostMicros(cap)} assistant budget. ${resets}`
      : `You've used this month's ${formatCostMicros(cap)} assistant budget. ${resets}`;
  }
  return window === 'today'
    ? `You've used today's assistant allowance. ${resets}`
    : `You've used this month's assistant allowance. ${resets}`;
}

export function createUsageMeter(db: RidikDatabase) {
  async function windowFor(from: string, to: string): Promise<UsageWindow> {
    const rows = await db
      .select({
        requests: sql<number>`coalesce(sum(${llmUsage.requests}), 0)`,
        calls: sql<number>`coalesce(sum(${llmUsage.calls}), 0)`,
        inputTokens: sql<number>`coalesce(sum(${llmUsage.inputTokens}), 0)`,
        cachedTokens: sql<number>`coalesce(sum(${llmUsage.cachedTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${llmUsage.outputTokens}), 0)`,
        costMicros: sql<number>`coalesce(sum(${llmUsage.costMicros}), 0)`,
      })
      .from(llmUsage)
      .where(and(gte(llmUsage.localDate, from), lte(llmUsage.localDate, to)));
    return rows[0] ?? EMPTY;
  }

  /**
   * The latest day this meter has ever recorded.
   *
   * Every ceiling here is keyed on a local date that comes from the device
   * clock, and Settings → Date & time is not a privileged surface: rolling the
   * clock back a month lands the reader on a window with no rows in it, which
   * reads as a full allowance. The table's own primary key already knows
   * better, so it is asked.
   */
  async function highWater(): Promise<string | null> {
    const rows = await db
      .select({ latest: sql<string | null>`max(${llmUsage.localDate})` })
      .from(llmUsage);
    return rows[0]?.latest ?? null;
  }

  /**
   * The day the meter will measure, which is the device's — unless the device's
   * is *earlier* than a day already recorded, in which case the clock has moved
   * backwards and the recorded one stands.
   *
   * Moving the clock forward still opens a fresh window, and that is left
   * alone deliberately: it is indistinguishable from time passing, and the
   * user pays for it by dragging every date in the app along with it. What
   * this closes is the free half of the trick — going forward, spending, and
   * coming back. The clock can now only ratchet.
   *
   * The one honest case it catches is crossing a date line westward, where a
   * day of usage merges into the previous window until the clock catches up.
   * That errs towards refusing, which is the direction this file always picks.
   */
  function effectiveDate(deviceDate: string, latest: string | null): string {
    return latest !== null && latest > deviceDate ? latest : deviceDate;
  }

  async function snapshot(
    caps: UsageCaps,
    zone = currentZone(),
    model = TYPICAL_MODEL,
  ): Promise<UsageSnapshot> {
    const today = effectiveDate(localDateOf(now(), zone), await highWater());
    // The month of that day, as a lexical range over the "YYYY-MM-DD" keys
    // themselves rather than a second conversion: the date has already been
    // resolved in the user's zone, and no key can sort above "-31".
    const month = today.slice(0, 7);
    const [todayWindow, monthWindow] = await Promise.all([
      windowFor(today, today),
      windowFor(`${month}-01`, `${month}-31`),
    ]);
    const limits = { daily: resolveCaps(caps.daily), monthly: resolveCaps(caps.monthly) };
    const dailyCap = capNumber(limits.daily.requests);
    const monthlyCap = capNumber(limits.monthly.requests);
    return {
      today: todayWindow,
      month: monthWindow,
      dailyCap,
      monthlyCap,
      remainingToday: Math.max(0, dailyCap - todayWindow.requests),
      remainingThisMonth: Math.max(0, monthlyCap - monthWindow.requests),
      limits,
      estimate: projectTurn(todayWindow, monthWindow, model),
    };
  }

  /**
   * Two queries and no writes: this runs in front of every utterance, and the
   * user is waiting on it with the microphone already closed.
   *
   * Nothing is reserved up front: a crash between check and record would
   * otherwise permanently burn a slot. At one request per utterance the race is
   * not worth the complexity — worst case the cap is exceeded by one.
   *
   * That reasoning holds for requests, which are countable. Tokens and money
   * are not knowable until the reply comes back, so the projected draw of the
   * next turn is added to what has already been spent and the *sum* is compared
   * to the cap. **We err towards refusing**: a turn is refused when it would
   * cross the line rather than after it has, which can leave up to one turn's
   * worth of allowance unspent. The other way round errs by one uncapped call,
   * and a single call carrying a large context is worth fifty small ones —
   * which is the entire reason a token cap exists. The cost of refusing early
   * is bounded and small: the turn is answered by the offline pattern matcher.
   */
  async function check(
    caps: UsageCaps,
    options: CheckOptions = {},
  ): Promise<Result<UsageSnapshot>> {
    const zone = options.zone ?? currentZone();
    const state = await snapshot(caps, zone, options.model ?? TYPICAL_MODEL);
    const fromHistory = state.estimate;
    const estimate: TurnEstimate = {
      tokens: Math.max(0, Math.round(options.estimate?.tokens ?? 0), fromHistory.tokens),
      costMicros: Math.max(
        0,
        Math.round(options.estimate?.costMicros ?? 0),
        fromHistory.costMicros,
      ),
    };
    const draw: Record<keyof WindowCaps, number> = { requests: 1, ...estimate };

    const windows = [
      { name: 'today' as const, window: state.today, caps: state.limits.daily },
      { name: 'month' as const, window: state.month, caps: state.limits.monthly },
    ];

    for (const unit of UNITS) {
      for (const w of windows) {
        const cap = w.caps[unit];
        if (cap.kind === 'unlimited') continue;
        const used = USED[unit](w.window);
        // At least 1, so an unpriced model (cost estimate 0) still stops dead
        // on a spent cap instead of drawing forever against it.
        const projected = used + Math.max(draw[unit], 1);
        if (projected <= cap.value) continue;
        const breach: UsageBreach = {
          window: w.name,
          unit,
          cap: cap.value,
          used,
          projected,
        };
        return fail('rate_limited', breachMessage(w.name, unit, cap.value), {
          details: { ...state, estimate, breach },
        });
      }
    }
    return ok(state);
  }

  /**
   * The reconcile half. What was actually billed, after the fact.
   *
   * Two counts, because one utterance can cost more than one billable call —
   * a transport retry, or a reply the schema rejected and the model was asked
   * to repair. `requests` stays one per utterance: it is what the sliders are
   * labelled in and what a plan is sold in, and adding the app's own retries to
   * it billed the user for them. `calls` is what the provider saw. Money is
   * honest in either case, because tokens and cost are summed across every
   * call before they get here.
   */
  async function record(input: {
    model: string;
    inputTokens?: number | undefined;
    /** Providers report this as part of `inputTokens`, not on top of it. */
    cachedTokens?: number | undefined;
    outputTokens?: number | undefined;
    /** Utterances. One, unless a caller is backfilling. */
    requests?: number | undefined;
    /** Billable provider calls behind them. Defaults to `requests`. */
    calls?: number | undefined;
    zone?: string;
  }): Promise<void> {
    const at = now();
    // Stamped with the same ratcheted day the windows are read against, or a
    // rolled-back clock would file the row where nothing will ever count it.
    const localDate = effectiveDate(
      localDateOf(at, input.zone ?? currentZone()),
      await highWater(),
    );
    const inputTokens = Math.max(0, Math.round(input.inputTokens ?? 0));
    const outputTokens = Math.max(0, Math.round(input.outputTokens ?? 0));
    const requests = Math.max(0, Math.round(input.requests ?? 1));
    const calls = Math.max(requests, Math.round(input.calls ?? requests));
    // A provider that reported more cached tokens than input tokens is talking
    // nonsense; clamp rather than let it turn into a negative bill.
    const cachedTokens = Math.min(Math.max(0, Math.round(input.cachedTokens ?? 0)), inputTokens);
    const costMicros = estimateCostMicros(input.model, inputTokens, outputTokens, cachedTokens);

    await db
      .insert(llmUsage)
      .values({
        localDate,
        requests,
        calls,
        inputTokens,
        cachedTokens,
        outputTokens,
        costMicros,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: llmUsage.localDate,
        set: {
          requests: sql`${llmUsage.requests} + ${requests}`,
          calls: sql`${llmUsage.calls} + ${calls}`,
          inputTokens: sql`${llmUsage.inputTokens} + ${inputTokens}`,
          cachedTokens: sql`${llmUsage.cachedTokens} + ${cachedTokens}`,
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
