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
 * The monthly cap to enforce for an entitlement.
 *
 * Free is zero: no plan, no assistant. It is not a small allowance — a trial
 * that quietly runs out is worse than an honest lock, and the free app is
 * genuinely complete without it.
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

export const FREE: Entitlement = {
  active: false,
  plan: null,
  tier: null,
  renewsAt: null,
  willRenew: false,
  since: null,
  inGracePeriod: false,
  store: null,
};

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
 * The current entitlement, or free.
 *
 * Never throws and never blocks a screen. A store that cannot be reached is not
 * evidence that someone has stopped paying — but it is not evidence they have
 * either, so an unreachable store reads as free and the UI says the status is
 * unknown rather than accusing them of not paying.
 */
export async function currentEntitlement(): Promise<Entitlement> {
  await whenReady();
  if (!provider) return FREE;
  try {
    return await provider.current();
  } catch (error) {
    log.warn('could not read the entitlement; treating as free for now', { error });
    return FREE;
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
