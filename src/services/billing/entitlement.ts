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
import { formatCount } from '@/core/format';
import { createLogger } from '@/core/logger';

const log = createLogger('billing');

/**
 * A thing that can be bought, named exactly as the RevenueCat package is.
 *
 * This was `'monthly' | 'yearly'` — a duration, which quietly assumed one plan
 * per billing period. Two tiers times two durations is four products, and the
 * duration alone cannot say which of two monthly products the user tapped. The
 * paywall showed nothing at all once the real offering existed, because the
 * lookup found no package called `$rc_monthly`.
 *
 * So the id IS the package's lookup key. One string, matched literally, with
 * no convention in the middle to drift: rename a package in the dashboard and
 * a test fails here rather than a paywall going quietly blank in production.
 */
export type PlanId = 'ridik_monthly' | 'ridik_yearly' | 'pro_monthly' | 'pro_yearly';

/** Every plan, in the order the paywall shows them: the badged row leads. */
export const PLAN_IDS: readonly PlanId[] = [
  'pro_yearly',
  'pro_monthly',
  'ridik_yearly',
  'ridik_monthly',
] as const;

/** Which row carries "Best value". Not "Most popular" — there are no users yet. */
export const HIGHLIGHTED_PLAN: PlanId = 'pro_yearly';

/**
 * How long one payment buys, per plan.
 *
 * A closed map rather than reading the duration out of the id. Six places used
 * to ask `plan === 'yearly'` or sniff `productIdentifier.includes('year')`, and
 * both are the kind of rule the RevenueCat dashboard has never agreed to: a
 * package called `pro_yearly_promo` satisfies the substring, and a package
 * called `annual` satisfies neither. When plan ids were durations those
 * questions were free; now that a plan is a tier *and* a duration, they have to
 * be answered from one table that fails to compile when a plan is added.
 */
export const PLAN_PERIOD: Record<PlanId, 'month' | 'year'> = {
  ridik_monthly: 'month',
  ridik_yearly: 'year',
  pro_monthly: 'month',
  pro_yearly: 'year',
};

export function isYearly(plan: PlanId): boolean {
  return PLAN_PERIOD[plan] === 'year';
}

/**
 * What separates the plans: how much of the assistant you get.
 *
 * Everything local is free and unlimited on every tier — notes, tasks, timers,
 * the timetable. What is metered is the part that costs money to run, which is
 * a request to the model. Counted in requests rather than money because a
 * request is a thing a person can picture, and it stays true if the provider
 * changes its prices.
 */
export type PlanTier = 'base' | 'pro';

/**
 * Assistant requests per month.
 *
 * 250 and 1,000: twice the money for four times as much, which is the whole
 * pitch and the reason both prices are round. $5 over 250 is 2p a request and
 * $10 over 1,000 is 1p — a division a tired person does in their head in under
 * a second, and the reason the monthly prices are not charm-priced. $4.99 over
 * 250 is 1.996p, which forces a rounding before the check completes.
 *
 * 250 is also chosen so the wall is a real event: it sits near the 88th
 * percentile of modelled usage, so about one subscriber in eight meets it in a
 * given month. The 1,500 that used to be here met 0.4% of them — an upgrade
 * screen that fires for one user in 233 is a page nobody reads.
 *
 * There is deliberately no uncapped tier. The previous `unlimited: 0` was a
 * magic zero meaning "no ceiling", and it is exactly what let a *free* user
 * inherit the operator's developer caps, because free also resolves to 0. If an
 * unlimited plan is ever sold it needs its own type, not a number that already
 * means something else.
 */
export const TIER_ALLOWANCE: Record<PlanTier, number> = {
  base: 250,
  pro: 1_000,
};

/**
 * The tier a plan belongs to, and the name that tier is sold under.
 *
 * These live here rather than in the RevenueCat adapter because they are facts
 * about what this app sells, not about the shop it sells through: a native
 * billing provider would need the same two tables, and the tier is what the
 * meter reads to decide how many requests a subscriber has bought.
 *
 * Closed maps, because a missing entry has to fail at compile time. Sniffing
 * `plan.startsWith('pro')` would answer for a plan called `promo_yearly` and
 * hand it four times the allowance it was paid for.
 */
/**
 * What a plan is worth, for deciding the direction of a change.
 *
 * The **tier only**. Commitment is deliberately not in here: a change of
 * billing period at the same tier is neither up nor down — the allowance is
 * identical and all that moves is how far ahead you have paid — and folding it
 * into the rank made monthly→yearly read as an upgrade, which would have
 * charged a prorated difference for an allowance that did not change.
 */
export function planRank(plan: PlanId): number {
  return PLAN_TIER[plan] === 'pro' ? 1 : 0;
}

export type PlanChange = 'upgrade' | 'downgrade' | 'crossgrade' | 'same';

/**
 * What buying `next` does to somebody already on `current`.
 *
 * The distinction is not cosmetic — it decides who pays what and when, and
 * getting it backwards either bills somebody twice or gives away a month.
 */
export function planChange(current: PlanId | null, next: PlanId): PlanChange {
  if (current === null) return 'same';
  if (current === next) return 'same';
  const from = planRank(current);
  const to = planRank(next);
  // Tier first and tier only. Same tier, different period, is a crossgrade
  // however the commitment moves — including Pro yearly to Pro monthly, which
  // shortens the commitment and changes no allowance at all.
  if (to > from) return 'upgrade';
  if (to < from) return 'downgrade';
  return 'crossgrade';
}

export const PLAN_TIER: Record<PlanId, PlanTier> = {
  ridik_monthly: 'base',
  ridik_yearly: 'base',
  pro_monthly: 'pro',
  pro_yearly: 'pro',
};

export const TIER_TITLE: Record<PlanTier, string> = {
  base: 'Ridik',
  pro: 'Ridik Pro',
};

export function tierFor(plan: PlanId): PlanTier {
  return PLAN_TIER[plan] ?? 'base';
}

/** What the store calls a plan on the paywall. */
export function titleFor(plan: PlanId): string {
  return TIER_TITLE[tierFor(plan)];
}

/** One line for the paywall, in the units the user is actually buying. */
export function describeAllowance(tier: PlanTier): string {
  return `${formatCount(TIER_ALLOWANCE[tier])} requests a month`;
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

/** The top-up consumable, priced by the store. */
export type TopUpProduct = { price: string; amount: number | null; currency: string | null };

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
  /**
   * The same price as a number, with its ISO currency, straight from the store.
   *
   * Only ever used to *derive* a second figure the store does not sell — the
   * per-month cost of a yearly plan, which is the whole point of offering one
   * and which no store returns. `price` stays the authority on what is charged;
   * this is what makes "$8.33 a month, billed yearly" possible without anybody
   * typing a number into the app.
   *
   * Null when the store did not report it. A missing amount hides the derived
   * line rather than guessing at one — an invented per-month figure on a real
   * paywall is a made-up price, whatever it was computed from.
   */
  amount: number | null;
  currency: string | null;
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
  /**
   * Opens the store's purchase sheet. Resolves to what the user ended on.
   *
   * `from` is the plan they already hold, when they hold one. Android needs it:
   * without the old product identifier Play starts a *second* subscription and
   * bills both. iOS ignores it and prorates on its own, provided the products
   * share a subscription group.
   */
  purchase(plan: PlanId, tier: PlanTier, from?: PlanId | null): Promise<Entitlement>;
  /**
   * Buys one top-up, and answers with the store's new count of them.
   *
   * A count rather than a balance: the store knows what was bought and this app
   * knows what has been spent, and neither should be asked the other's
   * question. Null when this provider sells no consumables.
   */
  topUp?(): Promise<number>;
  /** How many top-ups the store has ever recorded for this user. */
  topUpsPurchased?(): Promise<number>;
  /** The consumable's price, as the store formats it. Null when unavailable. */
  topUpProduct?(): Promise<TopUpProduct | null>;
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

export async function purchasePlan(
  plan: PlanId,
  tier: PlanTier,
  from?: PlanId | null,
): Promise<Entitlement> {
  if (!provider) throw new Error('Purchases are not available in this build.');
  return provider.purchase(plan, tier, from ?? null);
}

/**
 * Buys one top-up. Answers with the store's new count of them.
 *
 * Throws when the build cannot sell one, rather than resolving to 0 — a button
 * that quietly does nothing is worse than one that says why.
 */
export async function purchaseTopUp(): Promise<number> {
  if (!provider?.topUp) throw new Error('Top-ups are not available in this build.');
  return provider.topUp();
}

/**
 * How many top-ups the store has recorded. Zero when it cannot be asked.
 *
 * Zero and not "unchanged": this is half of a balance the app enforces, and an
 * unreadable half must never resolve in the direction that hands out requests.
 * A user whose store is unreachable keeps their subscription — that path is
 * `Entitlement.known` — and loses only the extra they bought on top, until it
 * can be asked again.
 */
export async function topUpsPurchased(): Promise<number> {
  if (!provider?.topUpsPurchased) return 0;
  try {
    return await provider.topUpsPurchased();
  } catch (error) {
    log.warn('could not read the top-up count', { error });
    return 0;
  }
}

/** What one top-up costs, or null when this build cannot sell one. */
export async function topUpProduct(): Promise<TopUpProduct | null> {
  if (!provider?.topUpProduct) return null;
  try {
    return await provider.topUpProduct();
  } catch (error) {
    log.warn('could not read the top-up product', { error });
    return null;
  }
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
  // The tier, not the billing period. This said "Yearly" for one commit after
  // the catalogue grew to four plans, which named the only half that does not
  // matter: "Yearly" is both the £49.99 Ridik and the £99.99 Pro, and the tier
  // is what decides whether the meter allows 250 requests a month or 1,000.
  // A subscriber could not tell from this screen which one they had bought.
  return entitlement.plan === null ? 'Subscribed' : titleFor(entitlement.plan);
}

/** "Yearly" / "Monthly", or null when nothing is being billed. */
export function describeBillingPeriod(entitlement: Entitlement): string | null {
  if (!entitlement.known || !entitlement.active || entitlement.plan === null) return null;
  return isYearly(entitlement.plan) ? 'Yearly' : 'Monthly';
}

/** What this entitlement buys per month, or null when nothing does. */
export function describePlanAllowance(entitlement: Entitlement): string | null {
  if (!entitlement.known || !entitlement.active || entitlement.plan === null) return null;
  return describeAllowance(tierFor(entitlement.plan));
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
  /*
   * A sandbox plan is not a purchase and must not be described as one.
   *
   * `development.ts` says in its own docblock that every screen showing a plan
   * says where the plan came from, and this sentence was the one that did not:
   * a local row granted by tapping a card rendered as "your card is charged
   * again then", on a device with no card, no receipt and no money moved. The
   * paywall was careful — em-dash prices, a Sandbox badge on every row — and
   * then the Settings row undid all of it one screen later.
   */
  if (entitlement.store === 'sandbox') {
    return entitlement.renewsAt === null
      ? 'A local test plan. Nothing was bought and no money moved.'
      : `A local test plan until ${format(entitlement.renewsAt)}. Nothing was bought and no money moved.`;
  }
  if (entitlement.renewsAt === null) {
    return entitlement.willRenew ? 'Renews automatically.' : 'Cancelled.';
  }
  return entitlement.willRenew
    ? `Renews ${format(entitlement.renewsAt)}, and your card is charged again then.`
    : `Ends ${format(entitlement.renewsAt)}. You keep the assistant until then.`;
}
