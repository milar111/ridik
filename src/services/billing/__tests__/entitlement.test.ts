import { freezeClock, resetClock } from '@/core/clock';
import {
  FREE,
  currentEntitlement,
  describePlan,
  describeRenewal,
  isStoreBuild,
  registerBillingProvider,
  UNKNOWN,
  type BillingProvider,
  type Entitlement,
} from '../entitlement';

const NOW = 1_772_000_000_000;
const DAY = 86_400_000;

const paid = (over: Partial<Entitlement> = {}): Entitlement => ({
  active: true,
  known: true,
  plan: 'ridik_monthly',
  tier: 'pro',
  renewsAt: NOW + 12 * DAY,
  willRenew: true,
  since: NOW - 90 * DAY,
  inGracePeriod: false,
  store: 'app-store',
  ...over,
});

const stub = (over: Partial<BillingProvider> = {}): BillingProvider => ({
  name: 'stub',
  sells: false,
  configure: async () => {},
  plans: async () => [],
  marketing: async () => null,
  current: async () => FREE,
  purchase: async () => FREE,
  restore: async () => FREE,
  manageUrl: () => 'https://example.test',
  ...over,
});

const when = (at: number): string => `on ${Math.round((at - NOW) / DAY)}d`;

beforeEach(() => freezeClock(NOW));
afterEach(() => {
  resetClock();
  registerBillingProvider(stub());
});

describe('currentEntitlement', () => {
  /* A store that cannot be reached is not evidence that somebody stopped
     paying, and reporting it as `FREE` was not a conservative default — it was
     a wrong answer that the money path could not see was wrong. `UNKNOWN` is
     the same shape, so nothing renders differently, and it carries the one bit
     that matters: we did not find out. */
  it('reports a store failure as unknown rather than as free', async () => {
    registerBillingProvider(
      stub({
        current: async () => {
          throw new Error('network down');
        },
      }),
    );

    const entitlement = await currentEntitlement();
    expect(entitlement).toEqual(UNKNOWN);
    expect(entitlement.known).toBe(false);
    expect(entitlement.active).toBe(false);
  });

  it('never surfaces the error to the caller', async () => {
    registerBillingProvider(
      stub({
        current: async () => {
          throw new Error('network down');
        },
      }),
    );
    await expect(currentEntitlement()).resolves.toBeTruthy();
  });

  /* A build with nothing registered has a different fact to report: there is
     nothing to have bought, and that IS knowable. */
  it('is knowably free in a build with no provider at all', async () => {
    await expect(currentEntitlement()).resolves.toEqual(FREE);
    expect(FREE.known).toBe(true);
  });

  it('trusts an answer the provider actually gave', async () => {
    registerBillingProvider(stub({ current: async () => paid() }));
    await expect(currentEntitlement()).resolves.toMatchObject({ active: true, known: true });
  });
});

describe('the copy for a store that did not answer', () => {
  /* Telling somebody who pays that they are on the free tier because their
     train went into a tunnel is the one wrong sentence here. */
  it('never says "Free" when the plan is merely unread', () => {
    expect(describePlan(UNKNOWN)).not.toMatch(/free/i);
    expect(describePlan(FREE)).toBe('Free');
  });

  it('says the store could not be reached rather than that the assistant is off', () => {
    const line = describeRenewal(UNKNOWN, () => 'someday');
    expect(line).toMatch(/store/i);
    expect(line).not.toMatch(/assistant is off/i);
  });
});

/*
 * The fact `current()` can never carry. Free means "chose not to pay" on a
 * store build and "there was nothing to buy" on a personal one, and the
 * assistant owes those two opposite answers — the whole free-tier hole was
 * the two being the same value.
 */
describe('isStoreBuild', () => {
  it('is true only for a provider that can actually take money', () => {
    registerBillingProvider(stub({ sells: true }));
    expect(isStoreBuild()).toBe(true);

    registerBillingProvider(stub({ sells: false }));
    expect(isStoreBuild()).toBe(false);
  });
});

describe('describePlan', () => {
  it('names the three states a subscriber can be in', () => {
    expect(describePlan(paid())).toBe('Monthly');
    expect(describePlan(paid({ plan: 'ridik_yearly' }))).toBe('Yearly');
    expect(describePlan(paid({ willRenew: false }))).toBe('Cancelled');
    expect(describePlan(FREE)).toBe('Free');
  });

  /* A failing card outranks everything: they still have the plan, and telling
     them it renews next week would be the one wrong thing to say. */
  it('puts a billing problem above the plan name', () => {
    expect(describePlan(paid({ inGracePeriod: true }))).toBe('Payment failed');
    expect(describePlan(paid({ inGracePeriod: true, willRenew: false }))).toBe('Payment failed');
  });
});

describe('describeRenewal', () => {
  it('says the card will be charged again, and when', () => {
    expect(describeRenewal(paid(), when)).toBe(
      'Renews on 12d, and your card is charged again then.',
    );
  });

  /* Cancelled is not the same as over. They paid for this period and keep it. */
  it('says when access ends rather than implying it already has', () => {
    expect(describeRenewal(paid({ willRenew: false }), when)).toBe(
      'Ends on 12d. You keep the assistant until then.',
    );
  });

  it('sends a failing card to the store, which is the only place it can be fixed', () => {
    expect(describeRenewal(paid({ inGracePeriod: true }), when)).toMatch(/update your card/i);
  });

  it('reassures the free tier that nothing of theirs is being held hostage', () => {
    expect(describeRenewal(FREE, when)).toMatch(/stays yours/i);
  });

  /* A store that returned no date is not an expired subscription. Formatting
     `null` would print "Renews Invalid Date". */
  it('does not invent a date the store did not give', () => {
    expect(describeRenewal(paid({ renewsAt: null }), when)).toBe('Renews automatically.');
    expect(describeRenewal(paid({ renewsAt: null, willRenew: false }), when)).toBe('Cancelled.');
  });
});
