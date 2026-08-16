/**
 * What the user is entitled to, from one place.
 *
 * Every screen and every network call asks this rather than a store SDK, so
 * there is exactly one file to change when the real one is wired up — and
 * exactly one place a bug about who has paid can live.
 *
 * The provider is injected rather than imported. `react-native-purchases` is a
 * native module: importing it here would make this file, the profile screen and
 * the hosted LLM client all unloadable under plain Node, and the rules about
 * grace periods and expiry are the part worth testing.
 *
 * A note on how the money actually moves, because it constrains everything
 * here: Apple and Google require their own purchase systems for digital
 * subscriptions, so Ridik cannot charge a card itself. What a store
 * subscription does is exactly the wanted behaviour anyway — the card on file
 * with the store is charged every period, automatically, until the user
 * cancels. Nothing in the app can take that decision for them, which is why
 * cancelling is a link out rather than a button.
 */
import { createLogger } from '@/core/logger';

const log = createLogger('billing');

export type PlanId = 'monthly' | 'yearly';

/**
 * What separates the plans: how much of the assistant you get.
 *
 * Everything local is free and unlimited on every tier — notes, tasks, timers,
 * the timetable. What is metered is the part that costs money to run, which is
 * a request to the model. Counted in requests rather than money because a
 * request is a thing a person can picture, and it stays true if the provider
 * changes its prices.
 */
export type PlanTier = 'light' | 'standard' | 'unlimited';

/** Assistant requests per month. 0 means uncapped. */
export const TIER_ALLOWANCE: Record<PlanTier, number> = {
  light: 300,
  standard: 1_500,
  unlimited: 0,
};

/** One line for the paywall, in the units the user is actually buying. */
export function describeAllowance(tier: PlanTier): string {
  const allowance = TIER_ALLOWANCE[tier];
  return allowance === 0
    ? 'Unlimited requests'
    : `${allowance.toLocaleString()} requests a month`;
}

/**
 * The monthly cap a *paid* entitlement buys, in requests. 0 means uncapped.
 *
 * Zero for free as well, which is why nothing may branch on this number alone:
 * "nothing bought" and "bought the Unlimited tier" answer identically here, and
 * treating that 0 as a cap is exactly how a free user inherited the operator's
 * developer caps. What a free install gets is `resolveAssistantBudget()` in
 * `./allowance`, and it is a lifetime trial rather than a monthly allowance.
 */
export function monthlyAllowance(entitlement: Entitlement): number {
  if (!entitlement.active || !entitlement.tier) return 0;
  return TIER_ALLOWANCE[entitlement.tier];
}

/**
 * What the paywall says, when the store is willing to say it.
 *
 * Prices are already the store's. This is the rest of the screen — the selling
 * points and the "best value" flag — so the whole thing can be reworded from a
 * dashboard without shipping a build. `null` means the store said nothing and
 * the app's own copy stands.
 */
export type Marketing = {
  benefits: string[];
  /** Which plan gets the badge, if any. */
  highlight: PlanId | null;
};

/** A thing that can be bought, priced by the store in the user's own currency. */
export type Plan = {
  id: PlanId;
  /** Which allowance this product buys. */
  tier: PlanTier;
  title: string;
  /** Already formatted and localised by the store. Never build this yourself. */
  price: string;
  /** "month" or "year" — what one `price` buys. */
  period: string;
  /** e.g. "Two months free" — only when the store's own numbers support it. */
  note?: string;
};

export type Entitlement = {
  /** False means the assistant is off; everything local still works. */
  active: boolean;
  /**
   * Whether the store actually answered.
   *
   * `active: false` has two completely different causes and they deserve
   * opposite treatment: the store said "nothing bought", or the store could not
   * be asked at all. Collapsing them is how a paying subscriber whose network
   * blinked got told they had used up a free trial they never started — the
   * store read failed, the entitlement came back free, and the free-tier lock
   * fired on somebody holding a receipt.
   *
   * False means *we do not know*. Nothing may charge a trial, lock the
   * assistant, or tell the user anything about what they have paid for while
   * this is false; see `resolveAssistantBudget`'s `unknown` state.
   */
  known: boolean;
  plan: PlanId | null;
  /** Which allowance they bought. Null on free. */
  tier: PlanTier | null;
  /**
   * End of the current paid period, epoch ms. Null when there is no plan, and
   * on a plan the store could not tell us about — which is not the same as
   * expired.
   */
  renewsAt: number | null;
  /**
   * False once the user has cancelled: the plan runs to `renewsAt` and stops.
   * True is the normal state — the card is charged again on that date.
   */
  willRenew: boolean;
  /** First time they ever subscribed, epoch ms. For "member since". */
  since: number | null;
  /**
   * True while a payment is failing but the store still considers them
   * subscribed. They keep everything; they just need telling.
   */
  inGracePeriod: boolean;
  /** Which store is billing them, for the copy that sends them to cancel. */
  store: 'app-store' | 'play-store' | 'sandbox' | null;
};

/** The store answered, and nothing is bought. */
export const FREE: Entitlement = {
  active: false,
  known: true,
  plan: null,
  tier: null,
  renewsAt: null,
  willRenew: false,
  since: null,
  inGracePeriod: false,
  store: null,
};

/**
 * The store did not answer.
 *
 * Shaped like `FREE` so every screen keeps rendering something sane, but the
 * money path must branch on `known` rather than on `active` — this is the value
 * a subscriber holds during an outage, a failed `configure()`, or the first
 * launch after a reinstall while offline.
 */
export const UNKNOWN: Entitlement = { ...FREE, known: false };

/**
 * What a store SDK has to provide. Deliberately small: anything more and the
 * seam stops being swappable.
 */
export type BillingProvider = {
  /** Called once at startup. Must not throw. */
  configure(): Promise<void>;
  /** What is for sale, priced by the store. */
  plans(): Promise<Plan[]>;
  /** Editable copy, or null to use the app's own. */
  marketing(): Promise<Marketing | null>;
  current(): Promise<Entitlement>;
  /** Opens the store's purchase sheet. Resolves to what the user ended on. */
  purchase(plan: PlanId, tier: PlanTier): Promise<Entitlement>;
  /** Required by both stores: a paid user reinstalling must get their plan back. */
  restore(): Promise<Entitlement>;
  /** Where this store lets a person cancel. Only the store can. */
  manageUrl(): string;
  /** Shown in the developer screen so it is never a mystery which one is live. */
  readonly name: string;
  /**
   * Whether this provider can actually take money.
   *
   * The one fact `current()` can never carry: a free entitlement means "nothing
   * bought" on a store build and "there was nothing to buy" on a personal one,
   * and those two deserve opposite answers about the assistant. True only for a
   * real store — the SDK compiled in and keyed. The development provider writes
   * a row to this device and sells nothing, so it is false there, and a build
   * carrying it keeps the developer caps it always had.
   */
  readonly sells: boolean;
};

let provider: BillingProvider | null = null;

/**
 * Resolves once startup has chosen a provider.
 *
 * The navigator mounts on the first render, before bootstrap has run, so a
 * screen deep-linked at cold start can ask what is for sale before there is
 * anything to ask. That returned an empty list, and React Query cached it —
 * the paywall then said "No plans available" for the rest of the session on a
 * device that had plans all along. Every read waits for this instead.
 */
let announce: () => void = () => {};
const ready: Promise<void> = new Promise((resolve) => {
  announce = resolve;
});

/** How long a read will wait for startup before giving up on it. */
const READY_TIMEOUT_MS = 5_000;

/**
 * Never rejects, and never waits forever.
 *
 * Already-registered is the common case and costs nothing. The timeout is the
 * backstop for the one that would otherwise be unrecoverable: a bootstrap that
 * threw before registering anything would leave every billing read pending for
 * the life of the process, and the profile would sit on a skeleton rather than
 * saying "Free".
 */
function whenReady(): Promise<void> {
  if (provider) return Promise.resolve();
  return Promise.race([
    ready,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, READY_TIMEOUT_MS);
      // Node keeps the process alive for a pending timer; the tests would hang
      // on teardown rather than on the read.
      timer.unref?.();
    }),
  ]);
}

export function registerBillingProvider(impl: BillingProvider): void {
  provider = impl;
  announce();
}

export function billingProviderName(): string | null {
  return provider?.name ?? null;
}

/**
 * True when this build can sell a subscription.
 *
 * Synchronous and total on purpose: it is asked on the money path of every
 * voice turn, before the network, and "we could not find out" would have to be
 * answered one way or the other anyway. Nothing registered yet reads as no
 * store, which is the safe direction — it withholds the lock, never the app.
 */
export function isStoreBuild(): boolean {
  return provider?.sells === true;
}

/**
 * The current entitlement, or an explicit "we could not find out".
 *
 * Never throws and never blocks a screen. A store that cannot be reached is not
 * evidence that someone has stopped paying, so the failure is reported as
 * `UNKNOWN` rather than as free: the two used to be the same value, and the
 * money path could not tell "chose not to pay" from "could not ask", which cost
 * a subscriber their assistant every time the network blinked.
 *
 * A build with no provider registered at all is a different fact again — there
 * is nothing to have bought — and `FREE` is the honest answer there, with
 * `isStoreBuild()` false to say so.
 */
export async function currentEntitlement(): Promise<Entitlement> {
  await whenReady();
  if (!provider) return FREE;
  try {
    return await provider.current();
  } catch (error) {
    log.warn('could not read the entitlement; the plan is unknown until the store answers', {
      error,
    });
    return UNKNOWN;
  }
}

export async function availablePlans(): Promise<Plan[]> {
  await whenReady();
  if (!provider) return [];
  try {
    return await provider.plans();
  } catch (error) {
    log.warn('could not load the plans', { error });
    return [];
  }
}

export async function planMarketing(): Promise<Marketing | null> {
  await whenReady();
  if (!provider) return null;
  try {
    return await provider.marketing();
  } catch (error) {
    log.warn('could not load the paywall copy; using the built-in text', { error });
    return null;
  }
}

export async function purchasePlan(plan: PlanId, tier: PlanTier): Promise<Entitlement> {
  if (!provider) throw new Error('Purchases are not available in this build.');
  return provider.purchase(plan, tier);
}

export async function restorePurchases(): Promise<Entitlement> {
  if (!provider) throw new Error('Purchases are not available in this build.');
  return provider.restore();
}

export function manageSubscriptionUrl(): string | null {
  return provider?.manageUrl() ?? null;
}

/** Startup. Safe to call when no provider is registered. */
export async function configureBilling(): Promise<void> {
  if (!provider) return;
  try {
    await provider.configure();
  } catch (error) {
    log.warn('billing did not configure; the app runs on the free tier', { error });
  }
}

/* ------------------------------------------------------------------ copy -- */

/** One line describing where the plan stands. */
export function describePlan(entitlement: Entitlement): string {
  // Not "Free": telling somebody who pays that they are on the free tier
  // because their train went into a tunnel is the one wrong answer here.
  if (!entitlement.known) return 'Checking…';
  if (!entitlement.active) return 'Free';
  if (entitlement.inGracePeriod) return 'Payment failed';
  if (!entitlement.willRenew) return 'Cancelled';
  return entitlement.plan === 'yearly' ? 'Yearly' : 'Monthly';
}

/**
 * The sentence under it. Three states people actually care about: it will
 * charge again, it will stop, or something is wrong with the card.
 */
export function describeRenewal(entitlement: Entitlement, format: (at: number) => string): string {
  if (!entitlement.known) {
    return 'Could not reach the store. Your plan is unchanged; this screen will catch up.';
  }
  if (!entitlement.active) return 'The assistant is off. Everything you have written stays yours.';
  if (entitlement.inGracePeriod) {
    return 'Your last payment did not go through. Update your card at the store to keep the assistant.';
  }
  if (entitlement.renewsAt === null) {
    return entitlement.willRenew ? 'Renews automatically.' : 'Cancelled.';
  }
  return entitlement.willRenew
    ? `Renews ${format(entitlement.renewsAt)}, and your card is charged again then.`
    : `Ends ${format(entitlement.renewsAt)}. You keep the assistant until then.`;
}
