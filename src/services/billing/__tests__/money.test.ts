/**
 * Prices, and the two ways a paywall lies without meaning to.
 *
 * The first is arithmetic: an app that computes a price shows a number nobody
 * agreed to charge. The second is notation: the store formats against the
 * *device* locale, so one phone reads "$99.99" and the next reads "99,99 US$"
 * for the identical charge — correct, and indistinguishable from a bug.
 *
 * `money.ts` is allowed to derive exactly one figure the store cannot answer —
 * what a yearly plan costs per month — and it is allowed to restate a price in
 * one notation. It is never allowed to change a currency. These tests are the
 * fence around that.
 */
import {
  BASE_CURRENCY,
  annualPitch,
  annualSaving,
  money,
  monthlyAmount,
  monthlyPitch,
  monthlyPrice,
  planFor,
  plansBilling,
} from '../money';
import type { Plan, PlanId, PlanTier } from '../entitlement';

function plan(id: PlanId, over: Partial<Plan> = {}): Plan {
  const tier: PlanTier = id.startsWith('pro') ? 'pro' : 'base';
  const yearly = id.endsWith('yearly');
  return {
    id,
    tier,
    title: tier === 'pro' ? 'Ridik Pro' : 'Ridik',
    price: yearly ? '$99.99' : '$10.00',
    period: yearly ? 'year' : 'month',
    amount: yearly ? 99.99 : 10,
    currency: 'USD',
    ...over,
  };
}

describe('a price reads the same on every phone', () => {
  /* The bug that started this: a US-dollar price on a device set to a European
     locale came back from the store as "99,99 US$". Nothing was wrong with it
     and it looked broken. */
  it('writes dollars as dollars, not as the device would', () => {
    expect(money(99.99, 'USD')).toBe('$99.99');
    expect(money(5, 'USD')).toBe('$5.00');
  });

  /* Ragged decimals in a column of prices look improvised. */
  it('always shows the cents', () => {
    expect(money(10, 'USD')).toBe('$10.00');
    expect(money(8.3325, 'USD')).toBe('$8.33');
  });

  /**
   * The line this file may not cross.
   *
   * Formatting is notation; the currency is a fact about what will be taken
   * from somebody's account. A euro price relabelled with a dollar sign is a
   * lie that happens to round correctly, and it is the exact failure the
   * "never rebuild the price string" rule in the adapter exists to prevent.
   */
  it('never converts, and never relabels', () => {
    const euros = money(99.99, 'EUR');
    expect(euros).not.toContain('$');
    expect(euros).toContain('99.99');
  });

  it('falls back to the base currency when the store named none', () => {
    expect(money(5, null)).toBe(money(5, BASE_CURRENCY));
  });

  /* Intl accepts any well-formed three-letter code and prints it verbatim
     rather than throwing, so an offering configured with a currency this
     runtime has no symbol for still renders a readable, honest price. */
  it('survives a currency code it has never heard of', () => {
    expect(money(5, 'ZZZ')).toContain('5.00');
    expect(money(5, 'ZZZ')).toContain('ZZZ');
  });

  it('refuses a number that is not a price', () => {
    expect(money(Number.NaN, 'USD')).toBeNull();
    expect(money(-1, 'USD')).toBeNull();
  });
});

describe('what a yearly plan costs per month', () => {
  /* The one figure the store does not sell and the only reason a yearly plan
     is worth offering. Comparing $99.99 to $10.00 is comparing a year to a
     month, and the reader should not have to do that division. */
  it('divides the year by twelve', () => {
    expect(monthlyAmount(plan('pro_yearly'))).toBeCloseTo(8.3325, 4);
    expect(monthlyPrice(plan('pro_yearly'))).toBe('$8.33');
  });

  it('leaves a monthly plan alone', () => {
    expect(monthlyAmount(plan('pro_monthly'))).toBe(10);
    expect(monthlyPrice(plan('pro_monthly'))).toBe('$10.00');
  });

  /**
   * No amount, no derived figure.
   *
   * The development provider prices everything "—" precisely so a build with
   * no store cannot show a number somebody might believe. Inventing a per-month
   * figure from a missing amount would put that number back.
   */
  it('says nothing when the store reported no amount', () => {
    expect(monthlyPrice(plan('pro_yearly', { amount: null }))).toBeNull();
    expect(monthlyAmount(plan('pro_yearly', { amount: null }))).toBeNull();
  });
});

describe('the saving badge', () => {
  it('is the real discount against twelve months', () => {
    // $120 a year at $10/month against $99.99 — 16.67%, floored.
    expect(annualSaving(plan('pro_monthly'), plan('pro_yearly'))).toBe(16);
  });

  /**
   * Rounded down, always.
   *
   * A badge that rounds up promises a discount the invoice does not contain.
   * Floored, a customer who checks the arithmetic finds slightly more than was
   * advertised, which is the only direction this error may go.
   */
  it('never advertises more than the invoice will show', () => {
    const monthly = plan('pro_monthly', { amount: 10 });
    const yearly = plan('pro_yearly', { amount: 99.99 });
    const claimed = annualSaving(monthly, yearly)!;
    const actual = ((10 * 12 - 99.99) / (10 * 12)) * 100;
    expect(claimed).toBeLessThanOrEqual(actual);
  });

  /* An offering can be misconfigured. "Save 0%" is worse than no badge, and a
     negative one would be an advertisement for the more expensive option. */
  it('says nothing when the year is not actually cheaper', () => {
    expect(annualSaving(plan('pro_monthly'), plan('pro_yearly', { amount: 120 }))).toBeNull();
    expect(annualSaving(plan('pro_monthly'), plan('pro_yearly', { amount: 130 }))).toBeNull();
  });

  it('says nothing when either price is unknown', () => {
    expect(annualSaving(plan('pro_monthly', { amount: null }), plan('pro_yearly'))).toBeNull();
    expect(annualSaving(null, plan('pro_yearly'))).toBeNull();
  });
});

describe('the sentence under the price', () => {
  /**
   * The total has to be the store's own string.
   *
   * It is the number that will leave the account, and it is the one figure on
   * the screen that must not have passed through any arithmetic here — the
   * headline above it already has.
   */
  it('quotes the store for what is actually charged', () => {
    const yearly = plan('pro_yearly', { price: '$99.99' });
    expect(annualPitch(yearly, plan('pro_monthly'))).toContain('$99.99');
  });

  it('repeats the monthly alternative so the comparison needs no second screen', () => {
    expect(annualPitch(plan('pro_yearly'), plan('pro_monthly'))).toContain('$10.00 if billed monthly');
  });

  it('drops the comparison rather than inventing one', () => {
    const pitch = annualPitch(plan('pro_yearly'), null);
    expect(pitch).toContain('$99.99');
    expect(pitch).not.toContain('if billed monthly');
  });

  /**
   * $99.99 / 12 is $8.3325, so twelve times the headline is not the total.
   * The copy must never claim it is — "billed yearly as $99.99 up front" is
   * true at any rounding; "$8.33 x 12" would not be.
   */
  it('never claims the headline multiplies back to the total', () => {
    const pitch = annualPitch(plan('pro_yearly'), plan('pro_monthly'));
    expect(pitch).not.toMatch(/x\s*12|times 12|\bper year\b.*8\.33/i);
  });

  it('says the monthly plan can be stopped', () => {
    expect(monthlyPitch()).toMatch(/cancel/i);
  });
});

describe('splitting the catalogue by how it bills', () => {
  const all = [plan('pro_yearly'), plan('pro_monthly'), plan('ridik_yearly'), plan('ridik_monthly')];

  it('gives one card per tier on each cadence', () => {
    expect(plansBilling(all, 'year').map((p) => p.tier)).toEqual(['pro', 'base']);
    expect(plansBilling(all, 'month').map((p) => p.tier)).toEqual(['pro', 'base']);
  });

  /* Catalogue order, not store order: the badged row leads, and an offering
     reordered in the dashboard must not move it. */
  it('keeps the badged tier first', () => {
    expect(plansBilling([...all].reverse(), 'year')[0]?.id).toBe('pro_yearly');
  });

  it('finds a plan by id, or admits it cannot', () => {
    expect(planFor(all, 'ridik_monthly')?.tier).toBe('base');
    expect(planFor([], 'ridik_monthly')).toBeNull();
  });
});
