/**
 * Prices, as the paywall says them.
 *
 * Pure, and deliberately the only place in the app that turns a number into
 * money. Two jobs:
 *
 *  1. **Say it the same way everywhere.** A store hands back a string it
 *     formatted against the *device's* locale, so the same $99.99 arrives as
 *     "$99.99" on one phone and "99,99 US$" on another. Both are correct and
 *     one of them looks like a bug. `money()` formats in en-US, so a dollar
 *     price reads as a dollar price on every device.
 *
 *  2. **Say the per-month cost of a yearly plan.** No store sells that number
 *     — you buy a year — and it is the only reason a yearly plan is worth
 *     offering. It is derived from the store's own amount, never typed here,
 *     so a price change in App Store Connect moves it on its own.
 *
 * The one thing this file must not become is a currency converter. It formats
 * whatever currency the store charged in; it never *changes* it. Showing "$5"
 * to somebody being billed in leva is the failure this whole module exists to
 * make impossible, and it is the same failure whether the number is invented
 * or merely relabelled.
 */
import { PLAN_IDS, PLAN_PERIOD, isYearly, type Plan, type PlanId } from './entitlement';

/** Ridik prices in USD. See `money()` for why that is not the same as forcing it. */
export const BASE_CURRENCY = 'USD';

const MONTHS_PER_YEAR = 12;

/**
 * A price, formatted the same way on every device.
 *
 * en-US rather than the device locale, and that is the whole point: prices are
 * set in dollars, so they should read as dollars — `$99.99`, not `99,99 US$`.
 * The *currency* still comes from the store, so a storefront that charges in
 * euros is formatted as euros, correctly, in a shape a reader of this app will
 * recognise. What is fixed is the notation, not the money.
 */
export function money(amount: number, currency: string | null): string | null {
  if (!Number.isFinite(amount) || amount < 0) return null;
  const code = (currency ?? BASE_CURRENCY).toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      // Two places, always. `$5` and `$5.00` in one column is the kind of
      // ragged table that makes a price list look improvised.
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // Intl accepts any well-formed three-letter code and prints it verbatim, so
    // this catches only a malformed one. A price with no symbol is still a true
    // price; a crashed paywall sells nothing.
    return `${amount.toFixed(2)} ${code}`;
  }
}

/**
 * What a plan costs per month, whichever way it is billed.
 *
 * A monthly plan answers with its own price. A yearly one answers with a
 * twelfth of it — the figure the card leads with, because comparing $99.99 to
 * $10.00 is comparing a year to a month and every reader has to do the division
 * themselves before the ladder makes any sense.
 *
 * Rounded to the cent it is displayed at, not to the exact quotient: $99.99/12
 * is $8.3325, and a card reading "$8.33 a month" beside "$99.99 billed yearly"
 * must not also claim the two multiply back exactly. They do not, and the copy
 * in `annualPitch()` is worded so it never says they do.
 */
export function monthlyAmount(plan: Plan): number | null {
  if (plan.amount == null) return null;
  return isYearly(plan.id) ? plan.amount / MONTHS_PER_YEAR : plan.amount;
}

/** The headline figure on a plan card: cost per month, formatted. */
export function monthlyPrice(plan: Plan): string | null {
  const amount = monthlyAmount(plan);
  return amount == null ? null : money(amount, plan.currency);
}

/**
 * How much cheaper a year is than twelve months, as a whole percent.
 *
 * Rounded *down*, so the badge can never overstate the saving: 16.675% is
 * advertised as 16%, and a customer who does the arithmetic finds slightly
 * more than was promised rather than slightly less. Null unless both prices
 * are known and the year is genuinely cheaper — an offering can be
 * misconfigured, and "Save 0%" is worse than no badge.
 */
export function annualSaving(monthly: Plan | null, yearly: Plan | null): number | null {
  if (!monthly?.amount || !yearly?.amount) return null;
  const twelve = monthly.amount * MONTHS_PER_YEAR;
  if (yearly.amount >= twelve) return null;
  const percent = Math.floor(((twelve - yearly.amount) / twelve) * 100);
  return percent > 0 ? percent : null;
}

/**
 * The sentence under a yearly plan's headline price.
 *
 * Modelled on how Claude states it, because it is the wording that survives
 * the obvious follow-up questions: it names the total that will actually leave
 * the account, says it goes up front, and repeats the monthly alternative so
 * the comparison does not require leaving the screen.
 *
 * The yearly total is the store's own `price` string rather than a formatted
 * amount — that string is what the store will charge, and it is the one number
 * on this screen that must not pass through any arithmetic.
 */
export function annualPitch(yearly: Plan, monthly: Plan | null): string {
  const upFront = yearly.price;
  const alternative = monthly?.amount != null ? money(monthly.amount, monthly.currency) : null;
  const tail = alternative ? ` ${alternative} if billed monthly.` : '';
  return `Per month, billed yearly as ${upFront} up front.${tail}`;
}

/** The sentence under a monthly plan's headline price. */
export function monthlyPitch(): string {
  return 'Per month, billed monthly. Cancel any time.';
}

/** The two plans of one tier, keyed by how they bill. */
export type Cadence = 'month' | 'year';

export function planFor(plans: readonly Plan[], id: PlanId): Plan | null {
  return plans.find((plan) => plan.id === id) ?? null;
}

/**
 * Every plan that bills on this cadence, in catalogue order.
 *
 * Sorted by `PLAN_IDS` and not left in the order the store returned them. The
 * offering's order lives in somebody's web dashboard, and the badged row has
 * to lead — `plan-catalog.test.ts` pins that the highlighted plan is first in
 * the catalogue, and filtering alone would have let a drag-and-drop in
 * RevenueCat quietly put the cheaper tier at the top of the paywall.
 */
export function plansBilling(plans: readonly Plan[], cadence: Cadence): Plan[] {
  const rank = (plan: Plan) => {
    const at = PLAN_IDS.indexOf(plan.id);
    return at === -1 ? PLAN_IDS.length : at;
  };
  return plans
    .filter((plan) => PLAN_PERIOD[plan.id] === cadence)
    .sort((a, b) => rank(a) - rank(b));
}
