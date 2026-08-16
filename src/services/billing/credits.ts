/**
 * The top-up: requests bought outright, spent only once nothing else is left.
 *
 * A subscription is a rate — so many requests a month, refilled by the clock.
 * A top-up is a quantity, and the two must never be mixed. Adding credits to a
 * monthly ceiling would hand them out again on the first of every month, which
 * is a $3 purchase that pays for ever; and metering them in `llm_usage`, which
 * counts a *window*, would throw them away at the same moment.
 *
 * So credits are a **balance**, modelled exactly like the trial and for the
 * same reason: both are lifetime counters, and a lifetime counter kept anywhere
 * the user can reset is a counter with a reset button on it.
 *
 *   purchased   the store's own count of consumable transactions. Never
 *               written by this app — RevenueCat is asked how many were
 *               bought, so a device that edits its database can lower its
 *               balance but cannot raise it.
 *   used        this app's counter, in `app_settings` and mirrored in
 *               SecureStore, read as the *larger* of the two so clearing
 *               either cannot refund anything.
 *
 * The asymmetry is the point. `purchased` is the number somebody paid for and
 * must be impossible to inflate; `used` is the number they have spent and must
 * be impossible to deflate. Both attacks are the same attack — free requests on
 * the operator's key — and each store is chosen for the direction it resists.
 */

/** The consumable, as configured in RevenueCat. Pinned; see the catalogue test. */
export const TOPUP_PRODUCT = 'ridik_topup_100';

/**
 * What one top-up buys.
 *
 * 100 requests for $3 — 3¢ each, against 1¢ on Ridik Pro. Pay-as-you-go costs
 * more per request than committing to a month, which is the honest shape: it
 * exists for the month you overshoot, not as a cheaper way to subscribe. A
 * top-up priced *below* the subscription rate would make the plans pointless.
 */
export const TOPUP_REQUESTS = 100;

/** What is left to spend, and what it was made of. */
export type CreditLedger = {
  /** Requests bought, per the store. */
  purchased: number;
  /** Requests already spent out of them. */
  used: number;
};

export const NO_CREDITS: CreditLedger = { purchased: 0, used: 0 };

/**
 * Requests still available, never negative.
 *
 * `NaN` in either field means a counter could not be read, and that is treated
 * as **no credits** rather than as zero-used. The trial reads an unreadable
 * counter as spent for the same reason: guessing the generous way turns a
 * broken database into a source of free requests, and guessing the strict way
 * costs one user a balance they can restore from the store.
 */
export function creditsRemaining(ledger: CreditLedger): number {
  const purchased = usable(ledger.purchased);
  const used = usable(ledger.used);
  if (purchased === null || used === null) return 0;
  return Math.max(0, purchased - used);
}

function usable(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

/** Credits bought, from the store's count of consumable transactions. */
export function purchasedFrom(transactions: number): number {
  return Math.max(0, Math.trunc(transactions)) * TOPUP_REQUESTS;
}

/**
 * The balance, in the units the buyer thinks in.
 *
 * Stated as requests rather than money, matching the plans: what was bought is
 * a number of turns, and converting it back to dollars invites the comparison
 * with the subscription that the top-up deliberately loses.
 */
export function describeCredits(ledger: CreditLedger): string {
  const left = creditsRemaining(ledger);
  if (left === 0) return 'No top-up requests left';
  return `${left.toLocaleString()} top-up ${left === 1 ? 'request' : 'requests'} left`;
}

/** What a single purchase adds, for the button that offers it. */
export function describeTopUp(): string {
  return `${TOPUP_REQUESTS} extra requests, once. They do not expire.`;
}
