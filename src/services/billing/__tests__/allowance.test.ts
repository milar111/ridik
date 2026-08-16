/**
 * The money gate, on its own.
 *
 * This is the function that decides whether a request to the model is made, so
 * the cases worth pinning down are the ones that cost money — or a customer —
 * when they are wrong. Four of them shipped: a free user inheriting the
 * operator's developer caps (200/day, 3,000/month of somebody else's invoice);
 * an Unlimited subscriber silently capped at the same numbers because their
 * tier and "no plan at all" are both the number 0 one layer down; a paying
 * subscriber hard-locked out of the assistant the first time the store failed
 * to answer; and the trial's own backstops measured against a table full of
 * that subscriber's paid traffic, so they were spent before they began.
 *
 * The ceilings are asserted as `Cap`s rather than numbers on purpose. "No
 * ceiling" and "a ceiling of zero" are the two answers this function has to
 * keep apart, and a test written in numbers cannot see the difference either.
 */
import { UNLIMITED, limitOf, TYPICAL_TURN_TOKENS, type Cap, type WindowCaps } from '@/llm/usage';

import {
  describeTrial,
  MAX_TURN_TOKENS,
  resolveAssistantBudget,
  TRIAL_TOTAL_REQUESTS,
  TRIAL_TOTAL_TOKENS,
  type AssistantBudget,
  type BudgetInput,
} from '../allowance';
import { FREE, UNKNOWN, type Entitlement } from '../entitlement';

const CAPS = { daily: 200, monthly: 3_000 };

const paid = (tier: Entitlement['tier']): Entitlement => ({
  active: true,
  known: true,
  plan: 'monthly',
  tier,
  renewsAt: null,
  willRenew: true,
  since: null,
  inGracePeriod: false,
  store: 'app-store',
});

/** Shorthand: the trial ledger, in whichever unit the case is about. */
const used = (requestsUsed = 0, tokensUsed = 0) => ({ requestsUsed, tokensUsed });

const resolve = (over: Partial<BudgetInput> = {}) =>
  resolveAssistantBudget({
    storeBuild: true,
    entitlement: FREE,
    trial: used(),
    caps: CAPS,
    ...over,
  });

/** The ceilings handed to the meter for one window. */
function capsFor(budget: AssistantBudget, which: 'daily' | 'monthly'): Partial<WindowCaps> {
  if (!budget.allowed) throw new Error('a refused budget has no caps; nothing may be spent');
  return budget.caps[which] as Partial<WindowCaps>;
}

const requestsIn = (budget: AssistantBudget, which: 'daily' | 'monthly'): Cap =>
  capsFor(budget, which).requests ?? UNLIMITED;

const tokensIn = (budget: AssistantBudget, which: 'daily' | 'monthly'): Cap =>
  capsFor(budget, which).tokens ?? UNLIMITED;

/** For comparisons only — `Infinity` is not a value the caps may ever carry. */
const ceiling = (cap: Cap): number =>
  cap.kind === 'unlimited' ? Number.POSITIVE_INFINITY : cap.value;

describe('a build with no store in it', () => {
  /* Somebody running Ridik on their own key. There is nothing to have bought,
     the invoice is theirs, and locking the assistant would be absurd. */
  it('keeps the developer caps exactly as they were', () => {
    const budget = resolve({ storeBuild: false });
    expect(budget).toMatchObject({ allowed: true, state: 'personal' });
    expect(requestsIn(budget, 'daily')).toEqual(limitOf(200));
    expect(requestsIn(budget, 'monthly')).toEqual(limitOf(3_000));
    // And nothing else: the token ceiling is a guard on the operator's money.
    expect(tokensIn(budget, 'monthly')).toEqual(UNLIMITED);
    expect(budget.allowed && budget.metersTrial).toBe(false);
  });

  it('still means "no ceiling" when the developer rows are zeroed', () => {
    const budget = resolve({ storeBuild: false, caps: { daily: 0, monthly: 0 } });
    expect(requestsIn(budget, 'daily')).toEqual(UNLIMITED);
    expect(requestsIn(budget, 'monthly')).toEqual(UNLIMITED);
  });

  it('does not spend the trial, however long the build runs', () => {
    const budget = resolve({ storeBuild: false, trial: used(10_000, TRIAL_TOTAL_TOKENS * 9) });
    expect(budget.allowed).toBe(true);
    expect(budget.allowed && budget.state).toBe('personal');
  });

  /* The per-turn ceiling guards somebody else's key. On a personal build there
     is nobody else: the user pasted the key and the bill is theirs. */
  it('lets a huge turn through, because the invoice is the user’s own', () => {
    const budget = resolve({ storeBuild: false, estimatedTokens: MAX_TURN_TOKENS * 50 });
    expect(budget.allowed).toBe(true);
  });

  /* The sandbox provider grants a real tier locally. It sells nothing, but a
     plan is a plan for the purposes of what the assistant is allowed to do. */
  it('still honours a plan granted without a store', () => {
    const budget = resolve({ storeBuild: false, entitlement: paid('light') });
    expect(budget).toMatchObject({ state: 'subscribed' });
    expect(requestsIn(budget, 'monthly')).toEqual(limitOf(300));
  });
});

describe('a subscriber', () => {
  it('gets the plan allowance when it is lower than the local brake', () => {
    const budget = resolve({ entitlement: paid('light') });
    expect(budget).toMatchObject({ state: 'subscribed' });
    expect(requestsIn(budget, 'daily')).toEqual(limitOf(200));
    expect(requestsIn(budget, 'monthly')).toEqual(limitOf(300));
  });

  it('gets the local brake when that is lower', () => {
    const budget = resolve({ entitlement: paid('standard'), caps: { daily: 200, monthly: 900 } });
    expect(requestsIn(budget, 'monthly')).toEqual(limitOf(900));
  });

  /* TIER_ALLOWANCE.unlimited is 0, which is also what free answers. The old
     expression could not tell them apart, so the fix had to not lock this. */
  it('is not capped by the free-tier lock when the tier is Unlimited', () => {
    const budget = resolve({ entitlement: paid('unlimited') });
    expect(budget.allowed).toBe(true);
    expect(budget).toMatchObject({ state: 'subscribed' });
    expect(requestsIn(budget, 'monthly')).toEqual(limitOf(3_000));
  });

  it('is uncapped when the operator has switched the local brake off too', () => {
    const budget = resolve({ entitlement: paid('unlimited'), caps: { daily: 0, monthly: 0 } });
    // `UNLIMITED`, never `limitOf(0)`: the same 0 from a *free* entitlement has
    // to refuse every call, and only this function knows which 0 it is holding.
    expect(requestsIn(budget, 'daily')).toEqual(UNLIMITED);
    expect(requestsIn(budget, 'monthly')).toEqual(UNLIMITED);
  });

  it('is never told about a trial it bought its way past', () => {
    const budget = resolve({
      entitlement: paid('standard'),
      trial: used(TRIAL_TOTAL_REQUESTS, TRIAL_TOTAL_TOKENS),
    });
    expect(budget.allowed).toBe(true);
    expect(budget.allowed && budget.notice).toBeNull();
    expect(budget.allowed && budget.metersTrial).toBe(false);
    expect(tokensIn(budget, 'monthly')).toEqual(UNLIMITED);
  });

  /* Somebody else's key is still paying for the request, so the one ceiling
     that survives a subscription is the size of a single utterance. */
  it('still refuses one absurdly large turn', () => {
    const budget = resolve({
      entitlement: paid('unlimited'),
      estimatedTokens: MAX_TURN_TOKENS + 1,
    });
    expect(budget).toMatchObject({ allowed: false, state: 'turn-too-large' });
    // And offers nothing to buy: no plan makes a megabyte paste sensible.
    expect(budget.allowed === false && budget.action).toBeNull();
  });
});

/**
 * The regression that mattered most, because it took the product away from the
 * people who had paid for it rather than merely leaking money.
 */
describe('a store that will not answer', () => {
  it('does not read as a decision not to pay', () => {
    const budget = resolve({ entitlement: UNKNOWN, trial: used(TRIAL_TOTAL_REQUESTS) });
    expect(budget).toMatchObject({ allowed: true, state: 'unknown' });
  });

  /* The precise shape of the bug: a subscriber who used the app before
     subscribing has a spent trial counter, so an unreachable store dropped them
     into `trial-spent` and stopped sending anything to the model. */
  it('never hard-locks a spent trial counter it cannot attribute', () => {
    for (const trial of [used(TRIAL_TOTAL_REQUESTS), used(0, TRIAL_TOTAL_TOKENS * 4)]) {
      expect(resolve({ entitlement: UNKNOWN, trial }).allowed).toBe(true);
    }
  });

  /* Nothing may be charged to a trial while we cannot say whose turn it is.
     The counter is monotonic, so a subscriber marching it towards 25 during
     outages was arming the lock above for themselves, permanently. */
  it('charges nothing to the trial', () => {
    const budget = resolve({ entitlement: UNKNOWN });
    expect(budget.allowed && budget.metersTrial).toBe(false);
  });

  /* Not a word about money to somebody whose plan we simply could not read. */
  it('says nothing to the user about a plan', () => {
    const budget = resolve({ entitlement: UNKNOWN });
    expect(budget.allowed && budget.notice).toBeNull();
    expect(budget.allowed && budget.action).toBeNull();
  });

  it('keeps the operator’s own ceilings under it', () => {
    const budget = resolve({ entitlement: UNKNOWN });
    expect(requestsIn(budget, 'daily')).toEqual(limitOf(200));
    expect(requestsIn(budget, 'monthly')).toEqual(limitOf(3_000));
  });

  it('still refuses one absurdly large turn on a store build', () => {
    const budget = resolve({ entitlement: UNKNOWN, estimatedTokens: MAX_TURN_TOKENS + 1 });
    expect(budget.allowed).toBe(false);
  });
});

describe('a free user on a store build', () => {
  /* The hole this whole change exists to close: 200 requests a day and 3,000 a
     month of the operator's Gemini budget, for somebody who has paid nothing.
     Walk the counter the pipeline keeps and the whole install is worth 25. */
  it('never inherits the developer caps, however many turns are taken', () => {
    let allowed = 0;
    for (let spent = 0; spent < 400; spent++) {
      if (!resolve({ trial: used(spent) }).allowed) break;
      allowed += 1;
    }
    expect(allowed).toBe(TRIAL_TOTAL_REQUESTS);
  });

  it('spends a lifetime trial rather than a monthly allowance', () => {
    const budget = resolve({ trial: used(TRIAL_TOTAL_REQUESTS - 1) });
    expect(budget).toMatchObject({ allowed: true, state: 'trial', metersTrial: true });
  });

  it('is refused once the trial is spent, and told what turns it back on', () => {
    const budget = resolve({ trial: used(TRIAL_TOTAL_REQUESTS) });
    expect(budget.allowed).toBe(false);
    if (budget.allowed) return;
    expect(budget.message).toMatch(/free assistant requests/i);
    expect(budget.message).toMatch(/still listens/i);
    expect(budget.message).toMatch(/plan/i);
    expect(budget.action).toEqual({ label: 'See plans', href: '/plans' });
  });

  /* A trial that a month rolls over is a subscription nobody is paying for. */
  it('stays refused no matter how long the user waits', () => {
    for (const spent of [TRIAL_TOTAL_REQUESTS, TRIAL_TOTAL_REQUESTS + 40, 10_000]) {
      expect(resolve({ trial: used(spent) }).allowed).toBe(false);
    }
  });

  it('warns near the end and says nothing while there is plenty left', () => {
    expect(resolve({ trial: used(0) })).toMatchObject({ notice: null });
    const nearly = resolve({ trial: used(TRIAL_TOTAL_REQUESTS - 3) });
    expect(nearly.allowed && nearly.notice).toMatch(/2 free assistant requests left/);
    const last = resolve({ trial: used(TRIAL_TOTAL_REQUESTS - 1) });
    expect(last.allowed && last.notice).toMatch(/last of your/i);
  });

  /* A counter that cannot be read at all must fail towards "spent": an
     unreadable database is otherwise a way to get another 25 requests. */
  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'treats an unreadable counter (%p) as spent',
    (spent) => {
      expect(resolve({ trial: used(spent as number) }).allowed).toBe(false);
      expect(resolve({ trial: used(0, spent as number) }).allowed).toBe(false);
    },
  );

  /* A negative one is merely nonsense rather than unreadable, so it clamps to
     zero — a clean trial, never a running start past one. */
  it('reads a negative counter as a fresh trial and no more', () => {
    expect(resolve({ trial: used(-5, -5_000_000) })).toEqual(resolve({ trial: used(0, 0) }));
  });

  /**
   * The trial's ceilings are its own, not the meter's.
   *
   * They used to be handed down as caps on `llm_usage`, which has no notion of
   * who paid: a subscriber who dropped into this state after 40 paid turns was
   * refused on their first free one, and a lapsed subscriber got literally zero
   * trial turns for the rest of the calendar month. The ledger this reads is
   * lifetime and belongs to the trial alone.
   */
  it('leaves the meter nothing but the operator’s own day and month brakes', () => {
    const budget = resolve({ trial: used(20) });
    expect(requestsIn(budget, 'daily')).toEqual(limitOf(200));
    expect(requestsIn(budget, 'monthly')).toEqual(limitOf(3_000));
    expect(tokensIn(budget, 'daily')).toEqual(UNLIMITED);
    expect(tokensIn(budget, 'monthly')).toEqual(UNLIMITED);
  });

  it('does not lean on the meter at all when the operator’s brakes are off', () => {
    const budget = resolve({ trial: used(20), caps: { daily: 0, monthly: 0 } });
    expect(requestsIn(budget, 'daily')).toEqual(UNLIMITED);
    // The gate is the lifetime ledger, and it is still 5 turns from the end.
    expect(budget).toMatchObject({ allowed: true, state: 'trial' });
  });

  /* The unit a request count cannot express. Twenty five requests buys twenty
     five *turns*, and one turn dragging a huge context bills like fifty — the
     free tier is the one allowance where that is somebody else's money. */
  it('is also spent in the unit the provider actually bills', () => {
    expect(resolve({ trial: used(1, TRIAL_TOTAL_TOKENS) }).allowed).toBe(false);
    const budget = resolve({ trial: used(1, TRIAL_TOTAL_TOKENS) });
    expect(budget.allowed === false && budget.message).toMatch(/free assistant allowance/i);
  });

  it('counts the turn it is about to take against the token ceiling', () => {
    // One ordinary turn short of the ceiling: this one must not be sent.
    const nearly = TRIAL_TOTAL_TOKENS - 10;
    expect(resolve({ trial: used(1, nearly), estimatedTokens: 1_000 }).allowed).toBe(false);
    expect(resolve({ trial: used(1, nearly), estimatedTokens: 5 }).allowed).toBe(true);
  });

  /* ...and that ceiling is a tripwire, not a second budget. Twenty five
     ordinary turns must fit under it with room to spare, or it would lock a
     user who still has requests in hand and blame the wrong thing. */
  it('leaves the token ceiling well clear of twenty five ordinary turns', () => {
    expect(TRIAL_TOTAL_TOKENS).toBeGreaterThan(TRIAL_TOTAL_REQUESTS * TYPICAL_TURN_TOKENS * 2);
  });

  it('refuses one turn too large to send before it spends a request on it', () => {
    const budget = resolve({ trial: used(0), estimatedTokens: MAX_TURN_TOKENS + 1 });
    expect(budget).toMatchObject({ allowed: false, state: 'turn-too-large' });
  });

  /* A single turn must not be able to swallow the whole trial in one go. */
  it('bounds one turn well below the whole trial', () => {
    expect(MAX_TURN_TOKENS).toBeLessThan(TRIAL_TOTAL_TOKENS / 4);
  });

  /* The backstop must never bite before the trial does. */
  it('does not let the daily meter lock a trial that still has requests in it', () => {
    const budget = resolve({ trial: used(TRIAL_TOTAL_REQUESTS - 5) });
    expect(ceiling(requestsIn(budget, 'daily'))).toBeGreaterThan(TRIAL_TOTAL_REQUESTS);
  });
});

describe('describeTrial', () => {
  it('counts down and stops at zero', () => {
    expect(describeTrial(0)).toBe(`${TRIAL_TOTAL_REQUESTS} of ${TRIAL_TOTAL_REQUESTS} free requests left`);
    expect(describeTrial(TRIAL_TOTAL_REQUESTS)).toBe(`0 of ${TRIAL_TOTAL_REQUESTS} free requests left`);
    expect(describeTrial(TRIAL_TOTAL_REQUESTS + 9)).toBe(`0 of ${TRIAL_TOTAL_REQUESTS} free requests left`);
  });
});
