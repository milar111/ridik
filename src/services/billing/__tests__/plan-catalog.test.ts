/**
 * The plans this app sells, and the dashboard it sells them from.
 *
 * These two drifted apart silently and the failure was total: `PACKAGE_FOR`
 * looked for RevenueCat's own `$rc_monthly` and `$rc_annual`, the real offering
 * carried four packages named after the tiers, `toPlan()` returned null for
 * every one of them, and the paywall rendered **no plans at all**. No error, no
 * log line, nothing to grep for — just a screen with nothing to buy on the one
 * surface where the app makes money.
 *
 * The lookup keys live in somebody else's web dashboard, so nothing here can
 * check them by reading. What this file can do is pin the app's half: every
 * plan is named, tiered, priced by duration and ordered, exactly once. If a
 * package is renamed in RevenueCat, this suite is the checklist of what has to
 * change with it.
 *
 * The dashboard side, as configured on 16 August 2026:
 *
 *   offering `default` (current)
 *     1. pro_yearly    -> ridik_pro_yearly     $99.99/year
 *     2. pro_monthly   -> ridik_pro_monthly    $10.00/month
 *     3. ridik_yearly  -> ridik_yearly         $49.99/year
 *     4. ridik_monthly -> ridik_monthly        $5.00/month
 *   entitlement `pro` <- all four
 *   consumable ridik_topup_100 $3.00, attached to nothing
 */
import {
  HIGHLIGHTED_PLAN,
  PLAN_IDS,
  PLAN_PERIOD,
  TIER_ALLOWANCE,
  describeAllowance,
  isYearly,
  type PlanId,
} from '../entitlement';

describe('the plan catalogue is complete', () => {
  it('sells four plans', () => {
    expect(PLAN_IDS).toHaveLength(4);
    expect(new Set(PLAN_IDS).size).toBe(4);
  });

  /* Two tiers times two durations. A plan missing from either map is a plan the
     paywall can render and the app cannot price or enforce. */
  it('knows the duration of every plan', () => {
    for (const plan of PLAN_IDS) {
      expect({ plan, period: PLAN_PERIOD[plan] }).toEqual({
        plan,
        period: expect.stringMatching(/^(month|year)$/),
      });
    }
  });

  it('covers both durations in both tiers', () => {
    const monthly = PLAN_IDS.filter((p) => !isYearly(p));
    const yearly = PLAN_IDS.filter(isYearly);
    expect(monthly).toHaveLength(2);
    expect(yearly).toHaveLength(2);
  });

  /* The badge exists to break the default-to-cheapest reflex, so it has to be
     on a row that is actually for sale. */
  it('highlights a plan it sells', () => {
    expect(PLAN_IDS).toContain(HIGHLIGHTED_PLAN);
  });

  /* The badged row leads. Ordering by price would put the cheapest first in
     every currency, which is the opposite of what the anchor is for. */
  it('puts the highlighted plan first', () => {
    expect(PLAN_IDS[0]).toBe(HIGHLIGHTED_PLAN);
  });
});

describe('the ladder gets cheaper the longer you commit', () => {
  /* The whole pitch, and the reason the monthly prices are round rather than
     charm-priced: $5 over 250 is 2p and $10 over 1,000 is 1p, a division a
     tired person does in their head. Prices live in the store, so what is
     asserted here is the half that decides them — the allowances. */
  it('gives the upper tier four times the allowance', () => {
    expect(TIER_ALLOWANCE.pro).toBe(TIER_ALLOWANCE.base * 4);
  });

  it('is 250 and 1,000', () => {
    expect(TIER_ALLOWANCE.base).toBe(250);
    expect(TIER_ALLOWANCE.pro).toBe(1_000);
  });

  /**
   * No tier may be uncapped.
   *
   * `TIER_ALLOWANCE.unlimited` used to be `0`, meaning "no ceiling" — and free
   * also resolves to 0, which is exactly how a free install inherited the
   * operator's developer caps and spent real money. If an unlimited plan is
   * ever sold it needs its own type rather than a number that already means
   * something else, and this test is what will stop it being reintroduced as
   * a zero.
   */
  it('never expresses an allowance as zero', () => {
    for (const [tier, allowance] of Object.entries(TIER_ALLOWANCE)) {
      expect({ tier, allowance }).toEqual({ tier, allowance: expect.any(Number) });
      expect(allowance).toBeGreaterThan(0);
    }
  });

  it('says what you get in the units you are buying', () => {
    expect(describeAllowance('base')).toBe('250 requests a month');
    expect(describeAllowance('pro')).toBe('1,000 requests a month');
  });
});

describe('the identifiers match the dashboard', () => {
  /* Pinned literally rather than derived. A rename in RevenueCat has to fail
     HERE — loudly, at build time — instead of on a paywall that quietly has
     nothing on it. */
  it('names the four packages the offering carries', () => {
    expect([...PLAN_IDS].sort()).toEqual(
      (['pro_monthly', 'pro_yearly', 'ridik_monthly', 'ridik_yearly'] as PlanId[]).sort(),
    );
  });

  /* RevenueCat's template offering ships `$rc_monthly`, `$rc_annual` and
     `$rc_weekly`. Those conventions are what the app used to look for, and they
     cannot express two tiers sharing a billing period — which is why the
     paywall went blank. Nothing may go back to them. */
  it('uses none of RevenueCat\'s generic package conventions', () => {
    for (const plan of PLAN_IDS) {
      expect(plan.startsWith('$rc_')).toBe(false);
    }
  });

  /* Weekly was considered and rejected: the meter only knows 'today' and
     'month', so a weekly plan needs a third window in the one module whose own
     docblocks show it has already been burned by that class of bug. */
  it('sells nothing weekly', () => {
    for (const plan of PLAN_IDS) {
      expect(plan).not.toMatch(/week/i);
    }
  });
});
