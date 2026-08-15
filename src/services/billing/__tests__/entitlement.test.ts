import { freezeClock, resetClock } from '@/core/clock';
import {
  FREE,
  currentEntitlement,
  describePlan,
  describeRenewal,
  registerBillingProvider,
  type BillingProvider,
  type Entitlement,
} from '../entitlement';

const NOW = 1_772_000_000_000;
const DAY = 86_400_000;

const paid = (over: Partial<Entitlement> = {}): Entitlement => ({
  active: true,
  plan: 'monthly',
  renewsAt: NOW + 12 * DAY,
  willRenew: true,
  since: NOW - 90 * DAY,
  inGracePeriod: false,
  store: 'app-store',
  ...over,
});

const stub = (over: Partial<BillingProvider> = {}): BillingProvider => ({
  name: 'stub',
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
     paying. It is also not evidence they are still paying, so free is the only
     safe answer — but it must never take the screen down with it. */
  it('falls back to free when the store throws rather than surfacing the error', async () => {
    registerBillingProvider(
      stub({
        current: async () => {
          throw new Error('network down');
        },
      }),
    );

    await expect(currentEntitlement()).resolves.toEqual(FREE);
  });

  it('is free in a build with no provider at all', async () => {
    // Nothing registered yet in this process is the same as no store.
    await expect(currentEntitlement()).resolves.toBeTruthy();
  });
});

describe('describePlan', () => {
  it('names the three states a subscriber can be in', () => {
    expect(describePlan(paid())).toBe('Monthly');
    expect(describePlan(paid({ plan: 'yearly' }))).toBe('Yearly');
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
