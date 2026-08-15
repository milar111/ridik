/**
 * What the user is entitled to, from one place.
 *
 * Every screen and every network call asks this rather than a store SDK, so
 * there is exactly one file to change when RevenueCat is wired up — and exactly
 * one place a bug about who has paid can live.
 *
 * The provider is injected rather than imported. `react-native-purchases` is a
 * native module: importing it here would make this file, the profile screen and
 * the hosted LLM client all unloadable under plain Node, and the rules about
 * grace periods and expiry are the part worth testing.
 */
import { createLogger } from '@/core/logger';

const log = createLogger('billing');

export type PlanId = 'free' | 'monthly' | 'yearly';

export type Entitlement = {
  /** False means the assistant is off; everything local still works. */
  active: boolean;
  plan: PlanId;
  /**
   * When the current period ends, epoch ms. Null on free, and on a plan the
   * store could not tell us about — which is not the same as expired.
   */
  renewsAt: number | null;
  /**
   * True while a payment is failing but the store still considers the user
   * subscribed. They keep everything; they just need telling.
   */
  inGracePeriod: boolean;
  /** Set when the user cancelled and the period has not run out yet. */
  cancelled: boolean;
};

export const FREE: Entitlement = {
  active: false,
  plan: 'free',
  renewsAt: null,
  inGracePeriod: false,
  cancelled: false,
};

/**
 * What a store SDK has to provide. Deliberately four methods: anything more
 * and the seam stops being swappable.
 */
export type BillingProvider = {
  /** Called once at startup. Must not throw. */
  configure(): Promise<void>;
  current(): Promise<Entitlement>;
  /** Opens the store's purchase sheet. Resolves to what the user ended on. */
  purchase(plan: Exclude<PlanId, 'free'>): Promise<Entitlement>;
  /** Required by both stores: a paid user reinstalling must get their plan back. */
  restore(): Promise<Entitlement>;
};

let provider: BillingProvider | null = null;

export function registerBillingProvider(impl: BillingProvider): void {
  provider = impl;
}

export function billingIsConfigured(): boolean {
  return provider !== null;
}

/**
 * The current entitlement, or free.
 *
 * Never throws and never blocks a screen. A store that cannot be reached is not
 * evidence that someone has stopped paying — but it is also not evidence they
 * have, so the honest answer while offline is the last thing we were told,
 * which the provider caches, falling back to free only on a cold start.
 */
export async function currentEntitlement(): Promise<Entitlement> {
  if (!provider) return FREE;
  try {
    return await provider.current();
  } catch (error) {
    log.warn('could not read the entitlement; treating as free for now', { error });
    return FREE;
  }
}

export async function purchasePlan(plan: Exclude<PlanId, 'free'>): Promise<Entitlement> {
  if (!provider) throw new Error('Purchases are not available in this build.');
  return provider.purchase(plan);
}

export async function restorePurchases(): Promise<Entitlement> {
  if (!provider) throw new Error('Purchases are not available in this build.');
  return provider.restore();
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

/** One line describing the plan, for the profile. */
export function describePlan(entitlement: Entitlement): string {
  if (!entitlement.active) return 'Free — the assistant is off';
  if (entitlement.inGracePeriod) return 'Payment problem — sort it out to keep the assistant';
  if (entitlement.cancelled) return 'Cancelled — runs until the end of the period';
  return entitlement.plan === 'yearly' ? 'Yearly' : 'Monthly';
}
