/**
 * Who is allowed to spend money on the model, and how much.
 *
 * One pure function, because the decision it makes is the one that costs real
 * money and it has to be readable in a test rather than inferred from a chain
 * of `? :` in the voice pipeline. It answers four questions that used to be
 * one, and being unable to tell them apart is what let a non-paying user spend
 * the operator's Gemini budget at 200 requests a day:
 *
 *   personal    no store is compiled into this build, so there is nothing to
 *               have bought. This is somebody running Ridik on their own key,
 *               and locking the assistant on them would be absurd — they keep
 *               the developer caps exactly as before.
 *   subscribed  the store says the plan is live. The plan's allowance applies,
 *               floored by the local developer cap so neither can be raised
 *               past the other by accident.
 *   unknown     the store could not be asked. Not the same as "nothing bought",
 *               and treating it as such takes the product away from the people
 *               who paid for it. See the note on that state below.
 *   trial       a store build with nothing bought, on a store that answered. A
 *               small LIFETIME allowance, stated in requests *and* in tokens
 *               because one turn can bill like fifty, then no billable call.
 *
 * The trial is deliberately not per-day and not per-month. A monthly free
 * allowance is a subscription somebody forgot to charge for: wait for the 1st
 * and it fills back up. This one is spent once, per install, and the only thing
 * that refills it is a plan.
 *
 * `monthlyAllowance()` returning 0 for both "free" and "unlimited" is what made
 * the old expression unfixable in place — 0 also means "uncapped" to the meter,
 * so testing `plan === 0` would have locked the Unlimited tier along with the
 * free one. Nothing here reads 0 as a state; the entitlement does, and every
 * ceiling that leaves this file is a `Cap` that says "unlimited" in words.
 *
 * This file decides *who* may spend and *how much*; `@/llm/usage` counts what
 * a *window* has drawn and owns those units. The trial does not go through the
 * meter at all — see `TrialLedger`.
 */
import {
  developerCap,
  limitOf,
  tighter,
  TYPICAL_TURN_TOKENS,
  UNLIMITED,
  type Cap,
  type UsageCaps,
} from '@/llm/usage';

import { monthlyAllowance, type Entitlement } from './entitlement';

/**
 * How many assistant requests a free install gets. Ever.
 *
 * A compile-time constant rather than a setting: a number that decides whether
 * the operator pays for a stranger's traffic does not belong behind seven taps
 * where a stranger can raise it. Big enough that someone can hear what the
 * assistant is actually for — a couple of days of ordinary use — and small
 * enough that it costs cents.
 */
export const TRIAL_TOTAL_REQUESTS = 25;

/**
 * How far past a normal turn the whole trial is allowed to reach.
 *
 * A request is a poor proxy for spend: the same 1 buys a 7,500-token turn or a
 * 400,000-token one, and the counter cannot tell. So the trial also carries a
 * token ceiling — the only unit the provider actually bills in — sized at four
 * times what 25 ordinary turns draw. Four, not one: one utterance can bill
 * three times over when the model's reply has to be repaired, and each rung
 * carries the last one's output, so an honest turn is not always a cheap one.
 */
const TRIAL_TOKEN_HEADROOM = 4;

/**
 * The most tokens a free install can draw before the model is cut off,
 * whatever its request counter says. ~750k of Gemini Flash input is about
 * twenty cents — the operator's true worst case per install, stated once.
 */
export const TRIAL_TOTAL_TOKENS = TRIAL_TOTAL_REQUESTS * TYPICAL_TURN_TOKENS * TRIAL_TOKEN_HEADROOM;

/**
 * The most one turn may be projected to draw, on any build where the invoice
 * is not the user's own.
 *
 * Nothing else bounds a single utterance. The prompt's own sections are
 * clamped, but the transcript is not: the typed box takes a paste, and a
 * megabyte of text is a quarter of a million tokens billed against somebody
 * else's key in exchange for one request off a counter. Eight ordinary turns'
 * worth is far more than anyone dictates or types in one go and still bounds
 * the pathological call to about a cent.
 *
 * Refused turns are not thrown away — they fall back to the offline matcher,
 * which for a very long paste means it is filed as a note, which is what the
 * user almost certainly wanted.
 */
export const MAX_TURN_TOKENS = TYPICAL_TURN_TOKENS * 8;

/** Below this many left, the user is told on every turn rather than surprised. */
const WARN_FROM = 5;

/**
 * The developer screen's own ceilings, in requests, carrying that screen's
 * convention: 0 means "no ceiling". Only `developerCap()` may read that 0, and
 * nothing derived from an entitlement is ever expressed this way.
 */
export type DeveloperCaps = { daily: number; monthly: number };

/**
 * What this install has spent of its free trial, for the whole life of the
 * install, in both units.
 *
 * Deliberately *not* the usage meter. The meter counts a local day and a local
 * calendar month out of one shared table, and both of those are wrong for a
 * lifetime budget in two different ways: the windows are keyed on a clock the
 * user can set, so a trial expressed in them is a trial you can wait out or
 * skip forward past; and the table has no notion of who paid, so a subscriber
 * who dropped into the trial state for one turn was measured against a month
 * of their own paid traffic and refused before spending a single free request.
 */
export type TrialLedger = {
  /** Lifetime turns already charged to the trial. */
  requestsUsed: number;
  /** Lifetime tokens already billed against it, summed across every call. */
  tokensUsed: number;
};

/** Where a notice can be acted on. One button, never a menu. */
export type BudgetAction = { label: string; href: string };

export type AssistantBudget =
  | {
      allowed: true;
      state: 'personal' | 'subscribed' | 'trial' | 'unknown';
      /**
       * What the meter must still enforce on top of this decision, in its own
       * units. Passed to `check()` unchanged.
       */
      caps: UsageCaps;
      /** True while the lifetime trial is what is paying for this turn. */
      metersTrial: boolean;
      /** Said on the turn, when the user needs to know where they stand. */
      notice: string | null;
      action: BudgetAction | null;
    }
  | {
      allowed: false;
      state: 'trial-spent' | 'turn-too-large';
      /** Shown and repeated on every turn: a silent downgrade is the bug. */
      message: string;
      action: BudgetAction | null;
    };

/** The one route that sells anything. */
const PLANS: BudgetAction = { label: 'See plans', href: '/plans' };

/**
 * What the user is told when the trial is gone.
 *
 * Three things, in this order, because the third is the one people assume is
 * false: what happened, that the app still works, and what turns it back on.
 * Never "something went wrong" — nothing went wrong.
 */
export const TRIAL_SPENT_MESSAGE =
  `That is all ${TRIAL_TOTAL_REQUESTS} of your free assistant requests. ` +
  'Ridik still listens and still writes notes, tasks and events from simple phrases — ' +
  'but it stops sending anything to the model until you pick a plan.';

/**
 * What the user is told when the trial's *token* tripwire bites before its
 * request counter does — a handful of very large turns rather than 25 ordinary
 * ones.
 *
 * The meter's own sentences all end on something resetting, because for a cap
 * they do. Nothing resets here: the free allowance is what ran out, and the
 * only thing that turns the model back on is a plan. Saying "it resets at
 * midnight" to somebody it will never come back for is the failure mode this
 * exists to avoid.
 */
export const TRIAL_LIMIT_MESSAGE =
  'This install has used its free assistant allowance. ' +
  'Ridik still listens and still writes notes, tasks and events from simple phrases — ' +
  'a plan turns the full assistant back on.';

/** What the user is told when one utterance is too big to send at all. */
export const TURN_TOO_LARGE_MESSAGE =
  'That is too much to send to the assistant in one go. ' +
  'Ridik has filed it with simple pattern matching instead — say it in smaller pieces ' +
  'if you want the full assistant on it.';

function trialNotice(leftAfterThisTurn: number): string | null {
  if (leftAfterThisTurn <= 0) {
    return (
      `That was the last of your ${TRIAL_TOTAL_REQUESTS} free assistant requests. ` +
      'From here Ridik answers offline until you pick a plan.'
    );
  }
  if (leftAfterThisTurn > WARN_FROM) return null;
  return (
    `${leftAfterThisTurn} free assistant request${leftAfterThisTurn === 1 ? '' : 's'} left. ` +
    'After that Ridik keeps working offline; a plan turns the full assistant back on.'
  );
}

/**
 * The plan's monthly ceiling and the local one, whichever bites first.
 *
 * A tier of 0 is Unlimited, not "no plan" — the caller has already established
 * that the entitlement is active — so it becomes `UNLIMITED` and `tighter()`
 * leaves the developer cap standing, which is itself `UNLIMITED` on a build
 * nobody has touched. This is the trap the `Cap` type exists for: the same 0
 * from a *free* entitlement would have to refuse every call, and only the
 * caller knows which 0 it is holding.
 */
function subscribedMonthly(plan: number, setting: Cap): Cap {
  return tighter(plan > 0 ? limitOf(plan) : UNLIMITED, setting);
}

export type BudgetInput = {
  /**
   * Whether this build's assistant is spending somebody else's money — a real
   * store is compiled in, the request goes through the operator's backend, or
   * the developer override that makes the lock reviewable without store keys.
   * False means a personal build, and a personal build is never locked.
   */
  storeBuild: boolean;
  entitlement: Entitlement;
  /** What this install has already spent of its lifetime free trial. */
  trial: TrialLedger;
  /** The developer screen's own ceilings, in requests, 0 for "no ceiling". */
  caps: DeveloperCaps;
  /**
   * What this turn is projected to draw, in tokens. Defaults to an ordinary
   * turn — which is the right default only because the caller that has a
   * transcript in hand passes the real projection.
   */
  estimatedTokens?: number;
};

/** Anything unreadable becomes 0, which is what the meter already reads as uncapped. */
const cap = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

/**
 * A stored counter that is negative, fractional or NaN must not read as credit.
 * An unreadable one reads as *spent*: a database that will not open is
 * otherwise a way to get the trial back.
 */
const spent = (value: number, whenUnreadable: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : whenUnreadable;

export function resolveAssistantBudget(input: BudgetInput): AssistantBudget {
  const daily = developerCap(cap(input.caps.daily));
  const monthly = developerCap(cap(input.caps.monthly));
  const projected = Math.max(0, Math.trunc(input.estimatedTokens ?? TYPICAL_TURN_TOKENS));

  const refuse = (
    state: 'trial-spent' | 'turn-too-large',
    message: string,
    action: BudgetAction | null,
  ): AssistantBudget => ({ allowed: false, state, message, action });

  // Paid first, so a subscriber is never asked about a trial they bought their
  // way past — including on a build with no store, where the sandbox provider
  // is the thing granting the plan.
  if (input.entitlement.active) {
    if (projected > MAX_TURN_TOKENS) {
      return refuse('turn-too-large', TURN_TOO_LARGE_MESSAGE, null);
    }
    return {
      allowed: true,
      state: 'subscribed',
      caps: {
        daily: { requests: daily },
        monthly: { requests: subscribedMonthly(monthlyAllowance(input.entitlement), monthly) },
      },
      metersTrial: false,
      notice: null,
      action: null,
    };
  }

  // The store did not answer. This is the branch that decides what happens to
  // somebody who pays while their train is in a tunnel, and the answer has to
  // be "nothing": they keep the assistant, nothing is charged to a trial they
  // never started, and no sentence is said to them about money.
  //
  // It is deliberately the same ceiling a personal build gets rather than
  // something tighter. Anything tighter has to be measured against the usage
  // meter, and the meter counts a *window* out of one shared table — so the
  // subscriber this branch exists to protect, who has been using the app all
  // day, is exactly the person a tight grace cap would refuse. The exposure it
  // leaves is bounded by the fact that reaching the model needs a network at
  // all: a store that cannot be reached from a device that can reach Gemini is
  // a targeted block, not an outage, and a device under that much of the
  // user's control has cheaper attacks available.
  if (!input.entitlement.known) {
    if (input.storeBuild && projected > MAX_TURN_TOKENS) {
      return refuse('turn-too-large', TURN_TOO_LARGE_MESSAGE, null);
    }
    return {
      allowed: true,
      state: 'unknown',
      caps: { daily: { requests: daily }, monthly: { requests: monthly } },
      metersTrial: false,
      notice: null,
      action: null,
    };
  }

  if (!input.storeBuild) {
    return {
      allowed: true,
      state: 'personal',
      // Byte for byte what this build has always enforced: the developer rows,
      // with their own 0-means-unlimited convention, and no token ceiling —
      // the invoice belongs to whoever pasted the key.
      caps: { daily: { requests: daily }, monthly: { requests: monthly } },
      metersTrial: false,
      notice: null,
      action: null,
    };
  }

  const requestsUsed = spent(input.trial.requestsUsed, TRIAL_TOTAL_REQUESTS);
  const remaining = Math.max(0, TRIAL_TOTAL_REQUESTS - requestsUsed);
  if (remaining === 0) return refuse('trial-spent', TRIAL_SPENT_MESSAGE, PLANS);

  if (projected > MAX_TURN_TOKENS) {
    return refuse('turn-too-large', TURN_TOO_LARGE_MESSAGE, null);
  }

  // The token tripwire, checked here rather than by the meter because it is a
  // lifetime figure and the meter only knows about today and this month. It is
  // the unit the counter above cannot express: 25 requests is 25 *turns*, and
  // a turn dragging a huge context — or repaired twice, billing three times —
  // costs many times an ordinary one while still counting as one.
  const tokensUsed = spent(input.trial.tokensUsed, TRIAL_TOTAL_TOKENS);
  if (tokensUsed + projected > TRIAL_TOTAL_TOKENS) {
    return refuse('trial-spent', TRIAL_LIMIT_MESSAGE, PLANS);
  }

  return {
    allowed: true,
    state: 'trial',
    // The lifetime ledger above is the gate. What is left here is the
    // operator's own day and month ceilings, which are about the size of the
    // bill rather than about who is entitled to it — and which the trial's 25
    // lifetime requests can only reach after somebody else has already spent
    // the day's 200.
    caps: { daily: { requests: daily }, monthly: { requests: monthly } },
    metersTrial: true,
    notice: trialNotice(remaining - 1),
    action: PLANS,
  };
}

/** One line for a read-out: "7 of 25 free requests left". */
export function describeTrial(trialUsed: number): string {
  const used = Math.min(TRIAL_TOTAL_REQUESTS, Math.max(0, Math.trunc(trialUsed)));
  return `${TRIAL_TOTAL_REQUESTS - used} of ${TRIAL_TOTAL_REQUESTS} free requests left`;
}
