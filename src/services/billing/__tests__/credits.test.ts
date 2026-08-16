/**
 * The top-up: the only budget in this app somebody paid cash for.
 *
 * That makes its failure modes asymmetric, and every test here is about one of
 * the two directions:
 *
 *   spending it too early    a $3 purchase consumed on turns a subscription
 *                            had already covered. The customer is charged
 *                            twice for the same request.
 *   spending it too late     or never — a balance that cannot be reached
 *                            because the door shut before it was consulted.
 *                            The customer is charged for nothing.
 *
 * The ordering in `resolveAssistantBudget` is what keeps both from happening,
 * and it is the reason credits are reached through `refuse()` rather than
 * checked up front.
 */
import { creditsCoverBreach, resolveAssistantBudget } from '../allowance';
import {
  NO_CREDITS,
  TOPUP_REQUESTS,
  creditsRemaining,
  describeCredits,
  purchasedFrom,
} from '../credits';
import { FREE, TIER_ALLOWANCE, type Entitlement } from '../entitlement';

const SUBSCRIBED: Entitlement = {
  active: true,
  known: true,
  plan: 'pro_yearly',
  tier: 'pro',
  renewsAt: null,
  willRenew: true,
  since: null,
  inGracePeriod: false,
  store: 'app-store',
};

const SPENT_TRIAL = { requestsUsed: 25_000, tokensUsed: 10_000_000 };
const FRESH_TRIAL = { requestsUsed: 0, tokensUsed: 0 };
const NO_CAPS = { daily: 0, monthly: 0 };

describe('what a top-up is worth', () => {
  it('buys a hundred requests', () => {
    expect(TOPUP_REQUESTS).toBe(100);
    expect(purchasedFrom(1)).toBe(100);
    expect(purchasedFrom(3)).toBe(300);
  });

  /**
   * Deliberately worse value than a plan.
   *
   * $3 for 100 is 3¢ a request; Ridik Pro is $10 for 1,000, or 1¢. A top-up
   * priced at or below the subscription rate makes the plans pointless — it
   * would be cheaper to buy thirty top-ups than to subscribe, and the whole
   * ladder collapses. This is the arithmetic that has to keep holding.
   */
  it('costs more per request than subscribing', () => {
    const topUpRate = 3 / TOPUP_REQUESTS;
    const proRate = 10 / TIER_ALLOWANCE.pro;
    expect(topUpRate).toBeGreaterThan(proRate);
  });

  it('cannot be bought a negative number of times', () => {
    expect(purchasedFrom(-2)).toBe(0);
  });

  /**
   * The store counts purchases; the ledger counts requests.
   *
   * Both are plain numbers, so nothing stopped a caller storing one where the
   * other belonged — and one did. A single $3 purchase showed as "1 top-up
   * request left" on the paywall and would have bought exactly one turn. The
   * conversion is the whole job of `purchasedFrom`, and the two units differ by
   * a factor of a hundred, which is why this is worth a test of its own: every
   * wrong answer here is off by 99 requests somebody paid for.
   */
  it('is a hundred requests per transaction, not one', () => {
    for (const transactions of [1, 2, 7]) {
      expect(purchasedFrom(transactions)).toBe(transactions * TOPUP_REQUESTS);
      expect(purchasedFrom(transactions)).not.toBe(transactions);
    }
  });

  /* The exact shape of the bug: a transaction count handed straight to the
     balance. One purchase must never leave the buyer with one request. */
  it('does not let a transaction count pass as a balance', () => {
    const wrong = creditsRemaining({ purchased: 1, used: 0 });
    const right = creditsRemaining({ purchased: purchasedFrom(1), used: 0 });
    expect(right).toBe(TOPUP_REQUESTS);
    expect(right).toBeGreaterThan(wrong);
  });
});

describe('the balance', () => {
  it('is what was bought, less what was spent', () => {
    expect(creditsRemaining({ purchased: 100, used: 40 })).toBe(60);
  });

  it('never goes below zero', () => {
    expect(creditsRemaining({ purchased: 100, used: 250 })).toBe(0);
  });

  /**
   * An unreadable counter is no credits, not "none spent".
   *
   * The generous reading turns a broken database into a supply of free
   * requests on the operator's key — the same attack the trial's `NaN`
   * handling exists to refuse, and here it would also be indistinguishable
   * from a genuine purchase.
   */
  it('reads an unreadable counter as empty', () => {
    expect(creditsRemaining({ purchased: 100, used: Number.NaN })).toBe(0);
    expect(creditsRemaining({ purchased: Number.NaN, used: 0 })).toBe(0);
  });

  it('says how many are left, in the unit they were sold in', () => {
    expect(describeCredits({ purchased: 100, used: 40 })).toBe('60 top-up requests left');
    expect(describeCredits({ purchased: 100, used: 99 })).toBe('1 top-up request left');
    expect(describeCredits(NO_CREDITS)).toBe('No top-up requests left');
  });
});

describe('when a top-up is spent', () => {
  /**
   * Never while something else is paying.
   *
   * This is the expensive direction to get wrong: the customer has a plan with
   * requests left in it, and a turn that draws on the top-up instead charges
   * them twice for one request. Credits are reached only through `refuse()`,
   * so a budget that says yes for any other reason never touches them.
   */
  it('is not touched while a subscription still allows the turn', () => {
    const budget = resolveAssistantBudget({
      storeBuild: true,
      entitlement: SUBSCRIBED,
      trial: FRESH_TRIAL,
      credits: { purchased: 100, used: 0 },
      caps: NO_CAPS,
    });

    expect(budget.allowed).toBe(true);
    expect(budget.allowed && budget.state).toBe('subscribed');
    expect(budget.allowed && budget.metersCredits).toBe(false);
  });

  it('is not touched while the free trial still has requests', () => {
    const budget = resolveAssistantBudget({
      storeBuild: true,
      entitlement: FREE,
      trial: FRESH_TRIAL,
      credits: { purchased: 100, used: 0 },
      caps: NO_CAPS,
    });

    expect(budget.allowed && budget.state).toBe('trial');
    expect(budget.allowed && budget.metersCredits).toBe(false);
    expect(budget.allowed && budget.metersTrial).toBe(true);
  });

  /**
   * And the other direction: a balance that cannot be reached is a purchase
   * that bought nothing. A spent trial used to be the end of the road.
   */
  it('answers once the trial is gone', () => {
    const budget = resolveAssistantBudget({
      storeBuild: true,
      entitlement: FREE,
      trial: SPENT_TRIAL,
      credits: { purchased: 100, used: 0 },
      caps: NO_CAPS,
    });

    expect(budget.allowed).toBe(true);
    expect(budget.allowed && budget.state).toBe('credits');
    expect(budget.allowed && budget.metersCredits).toBe(true);
    expect(budget.allowed && budget.metersTrial).toBe(false);
  });

  /* Two lifetime balances that mean opposite things. Charging both would spend
     somebody's $3 on a sample they had already used up. */
  it('never meters the trial and a top-up on the same turn', () => {
    const budget = resolveAssistantBudget({
      storeBuild: true,
      entitlement: FREE,
      trial: SPENT_TRIAL,
      credits: { purchased: 100, used: 0 },
      caps: NO_CAPS,
    });

    expect(budget.allowed && budget.metersTrial && budget.metersCredits).toBe(false);
  });

  it('shuts the door again once the balance is spent', () => {
    const budget = resolveAssistantBudget({
      storeBuild: true,
      entitlement: FREE,
      trial: SPENT_TRIAL,
      credits: { purchased: 100, used: 100 },
      caps: NO_CAPS,
    });

    expect(budget.allowed).toBe(false);
    expect(budget.allowed === false && budget.state).toBe('trial-spent');
  });

  it('behaves exactly as before for an install that never bought one', () => {
    const budget = resolveAssistantBudget({
      storeBuild: true,
      entitlement: FREE,
      trial: SPENT_TRIAL,
      caps: NO_CAPS,
    });

    expect(budget.allowed).toBe(false);
  });

  /**
   * A bought balance does not buy the operator's ceilings.
   *
   * The day and month caps are about the size of the bill rather than who is
   * entitled to it, so a turn projected past the per-turn token ceiling is
   * refused whoever is paying — otherwise a $3 purchase is a way to send one
   * enormous context that costs many times that.
   */
  it('does not let a bought request send an unbounded turn', () => {
    const budget = resolveAssistantBudget({
      storeBuild: true,
      entitlement: FREE,
      trial: SPENT_TRIAL,
      credits: { purchased: 100, used: 0 },
      caps: NO_CAPS,
      estimatedTokens: 10_000_000,
    });

    expect(budget.allowed).toBe(false);
  });

  /**
   * The moment the top-up was actually sold for.
   *
   * A 250-a-month subscriber speaks their 251st utterance. That refusal does
   * not come from `resolveAssistantBudget` — the plan is active and the trial
   * is irrelevant — it comes from the *meter*, downstream. The only path to the
   * balance ran through `refuse()` inside the first decision, so the person who
   * bought a top-up for exactly this was told to wait until next month with
   * 100 paid requests untouched, on a screen that promises the opposite.
   */
  it('covers a subscriber whose month has run out', () => {
    const budget = resolveAssistantBudget({
      storeBuild: true,
      entitlement: SUBSCRIBED,
      trial: FRESH_TRIAL,
      credits: { purchased: 100, used: 0 },
      caps: NO_CAPS,
    });

    const covered = creditsCoverBreach({
      budget,
      credits: { purchased: 100, used: 0 },
      window: 'month',
    });

    expect(covered?.allowed).toBe(true);
    expect(covered?.allowed && covered.state).toBe('credits');
    expect(covered?.allowed && covered.metersCredits).toBe(true);
  });

  /**
   * The daily window is the operator's rate limit, not an allowance anybody
   * bought. A top-up buys 100 requests; it does not buy the right to spend
   * them all this afternoon on somebody else's key.
   */
  it('does not buy out the daily rate limit', () => {
    const budget = resolveAssistantBudget({
      storeBuild: true,
      entitlement: SUBSCRIBED,
      trial: FRESH_TRIAL,
      credits: { purchased: 100, used: 0 },
      caps: NO_CAPS,
    });

    expect(
      creditsCoverBreach({ budget, credits: { purchased: 100, used: 0 }, window: 'today' }),
    ).toBeNull();
  });

  /* A personal build's ceilings are the developer's own sliders, and there is
     nothing to buy on it anyway. */
  it('does not overturn a developer cap on a personal build', () => {
    const budget = resolveAssistantBudget({
      storeBuild: false,
      entitlement: FREE,
      trial: FRESH_TRIAL,
      credits: { purchased: 100, used: 0 },
      caps: { daily: 5, monthly: 50 },
    });

    expect(budget.allowed && budget.state).toBe('personal');
    expect(
      creditsCoverBreach({ budget, credits: { purchased: 100, used: 0 }, window: 'month' }),
    ).toBeNull();
  });

  it('still refuses when the balance is empty', () => {
    const budget = resolveAssistantBudget({
      storeBuild: true,
      entitlement: SUBSCRIBED,
      trial: FRESH_TRIAL,
      credits: { purchased: 100, used: 100 },
      caps: NO_CAPS,
    });

    expect(
      creditsCoverBreach({ budget, credits: { purchased: 100, used: 100 }, window: 'month' }),
    ).toBeNull();
  });

  /* Said on every turn a top-up pays for, not only at the end: it is the one
     budget that shrinks with nothing to refill it. */
  it('says whose requests are being spent', () => {
    const budget = resolveAssistantBudget({
      storeBuild: true,
      entitlement: FREE,
      trial: SPENT_TRIAL,
      credits: { purchased: 100, used: 60 },
      caps: NO_CAPS,
    });

    expect(budget.allowed && budget.notice).toContain('40 top-up requests left');
  });
});
