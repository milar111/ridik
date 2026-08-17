/**
 * Changing plan, and the money that rides on getting the direction right.
 *
 * This app cannot prorate anything itself — Apple and Google require their own
 * purchase systems, so the stores own the arithmetic. What the app owns is
 * *telling them what kind of change this is*, and that turned out to be
 * missing entirely: `purchasePackage(target)` with no old product.
 *
 * On iOS that is survivable. StoreKit sees both products in one subscription
 * group, cancels the old one, credits the unused time and charges the
 * difference, with nothing asked of us.
 *
 * On Android it is a money bug pointing at the customer. Play treats a
 * purchase with no `oldProductIdentifier` as unrelated, so somebody upgrading
 * from Ridik to Ridik Pro ends up holding **two live subscriptions and paying
 * for both**, while the app shows whichever entitlement resolved.
 *
 * The replacement mode is chosen per direction, and this file is where that
 * choice is written down and defended.
 */
import { planChange, planRank } from '../entitlement';

describe('which way a plan change goes', () => {
  it('calls more allowance an upgrade', () => {
    expect(planChange('ridik_monthly', 'pro_monthly')).toBe('upgrade');
    expect(planChange('ridik_yearly', 'pro_yearly')).toBe('upgrade');
  });

  it('calls less allowance a downgrade', () => {
    expect(planChange('pro_monthly', 'ridik_monthly')).toBe('downgrade');
    expect(planChange('pro_yearly', 'ridik_yearly')).toBe('downgrade');
  });

  /* Same tier, different commitment. Neither party is better off in allowance
     terms; what changes is how far ahead they have paid. */
  it('calls a change of commitment at the same tier a crossgrade', () => {
    expect(planChange('ridik_monthly', 'ridik_yearly')).toBe('crossgrade');
    expect(planChange('pro_yearly', 'pro_monthly')).toBe('crossgrade');
  });

  /**
   * The tier decides, and the commitment does not enter into it.
   *
   * Ridik yearly → Pro monthly shortens the commitment and quadruples the
   * allowance. If the commitment counted, that would rank as a downgrade and
   * take `DEFERRED` — so somebody who had just paid for more would wait up to
   * a year to receive it.
   */
  it('treats a tier jump as an upgrade even when the commitment shortens', () => {
    expect(planChange('ridik_yearly', 'pro_monthly')).toBe('upgrade');
    expect(planRank('pro_monthly')).toBeGreaterThan(planRank('ridik_yearly'));
  });

  it('is not a change at all when nothing changes', () => {
    expect(planChange('pro_yearly', 'pro_yearly')).toBe('same');
    expect(planChange(null, 'pro_yearly')).toBe('same');
  });
});

describe('the replacement mode each direction gets', () => {
  /* Read from the source: the values are strings the SDK understands, and the
     whole point is that the *pairing* is deliberate rather than a default. */
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'revenuecat.ts'),
    'utf8',
  ) as string;

  /**
   * An upgrade takes effect now and costs only the difference.
   *
   * `CHARGE_PRORATED_PRICE` keeps the billing date where it is and charges for
   * the days remaining at the new rate. The user gets the larger allowance
   * immediately and pays exactly what those days are worth — nothing refunded,
   * nothing given away.
   */
  it('charges an upgrade the prorated difference, not a fresh period', () => {
    expect(source).toMatch(/upgrade:\s*'CHARGE_PRORATED_PRICE'/);
  });

  /**
   * A downgrade waits.
   *
   * `DEFERRED` lets them keep what they already paid for until it expires, then
   * drops them. No refund, and that is the fair reading in both directions:
   * they had the larger allowance for the whole period they are paying for.
   */
  it('defers a downgrade to the end of the paid period', () => {
    expect(source).toMatch(/downgrade:\s*'DEFERRED'/);
  });

  it('turns unused time into time on the new plan for a crossgrade', () => {
    expect(source).toMatch(/crossgrade:\s*'WITH_TIME_PRORATION'/);
  });

  /**
   * The greedy mode, deliberately unused.
   *
   * `CHARGE_FULL_PRICE` bills a whole new billing cycle immediately and hands
   * the old plan's remaining days back as extra time on top. It is more money
   * sooner and it is the option a customer notices.
   */
  it('never charges a full new period on top', () => {
    // As a *value*, not as prose — the docblock above the map names it in order
    // to say it is not used, and that sentence should stay.
    expect(source).not.toMatch(/(upgrade|downgrade|crossgrade):\s*'CHARGE_FULL_PRICE'/);
  });

  /* Android only: iOS prorates on its own and rejects the argument. */
  it('only sends a product change on android', () => {
    expect(source).toMatch(/Platform\.OS === 'android' && from && change !== 'same'/);
  });

  /**
   * The bug this all exists for.
   *
   * Without `oldProductIdentifier`, Play starts a second subscription and bills
   * both. If this assertion ever fails, somebody is being charged twice.
   */
  it('always names the subscription it is replacing', () => {
    expect(source).toMatch(/oldProductIdentifier:\s*PRODUCT_FOR\[from\]/);
  });
});
