/**
 * The real store, through RevenueCat.
 *
 * RevenueCat wraps StoreKit on iOS and Play Billing on Android, which is what
 * makes one entitlement mean the same thing on both. It is also the only legal
 * way to sell this: Apple and Google require their own purchase systems for
 * digital subscriptions, so the card stays with the store and is charged every
 * period automatically until the user cancels.
 *
 * Loaded optionally, like `focus/liveActivity.ts`. `react-native-purchases` is
 * a native module; importing it unconditionally would make the profile screen
 * unloadable in tests and in any build without it compiled in.
 *
 * To make this the live provider:
 *   1. `npx expo install react-native-purchases`
 *   2. Create the subscription products in App Store Connect and Play Console,
 *      then an entitlement in RevenueCat with both attached, and an offering
 *      whose packages are the monthly and yearly ones. The entitlement is
 *      `assistant` unless `extra.revenueCat.entitlement` says otherwise.
 *   3. Put the two public SDK keys in `app.config.ts` under
 *      `extra.revenueCat = { ios, android }` — in practice via the
 *      `EXPO_PUBLIC_REVENUECAT_*` environment variables that file reads. They
 *      are publishable keys and belong in the build; the secret key never goes
 *      near the app.
 *   4. `npx expo prebuild --clean && npx expo run:ios` / `run:android`.
 * Nothing else changes: `isAvailable()` starts returning true and the startup
 * registration picks this over the development provider.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { createLogger } from '@/core/logger';
import { TOPUP_PRODUCT } from './credits';
import {
  FREE,
  PLAN_IDS,
  PLAN_PERIOD,
  planChange,
  tierFor,
  titleFor,
  type BillingProvider,
  type Entitlement,
  type Plan,
  type PlanChange,
  type PlanId,
  type PlanTier,
} from './entitlement';

const log = createLogger('billing/revenuecat');

/**
 * The entitlement identifier configured in the RevenueCat dashboard.
 *
 * What shipped, and the fallback for every build that does not say otherwise.
 * It is a dashboard-owned string, so it is read from config rather than frozen
 * here — renaming the entitlement in RevenueCat would otherwise mean nobody is
 * ever subscribed until the next release, and the failure is silent.
 */
const DEFAULT_ENTITLEMENT = 'assistant';

/**
 * A `PlanId` IS the package's lookup key, so this map is the identity.
 *
 * It used to translate — `monthly` to RevenueCat's own `$rc_monthly` — and that
 * indirection is what broke the paywall the moment a real offering existed: the
 * offering has four packages across two tiers, `$rc_monthly` names at most one
 * of them, and `toPlan()` returned null for every package it did not recognise.
 * A paywall with no plans, no error, and nothing in the logs.
 *
 * Kept as a function rather than deleted so the coupling stays named: if the
 * dashboard's lookup keys are ever renamed, this is the one place to translate
 * again, and `plan-catalog.test.ts` fails rather than the screen going blank.
 */
const packageKeyFor = (plan: PlanId): string => plan;

/** What each row is called on the paywall. Two tiers, two durations. */
type Config = { ios?: string; android?: string; entitlement?: string };

function config(): Config {
  return ((Constants.expoConfig?.extra ?? {}) as { revenueCat?: Config }).revenueCat ?? {};
}

function apiKey(): string | null {
  const extra = config();
  const key = Platform.OS === 'ios' ? extra.ios : extra.android;
  return key?.trim() ? key.trim() : null;
}

/** Read per call, not cached: `expoConfig` is not populated at module load. */
function entitlementId(): string {
  const configured = config().entitlement?.trim();
  return configured ? configured : DEFAULT_ENTITLEMENT;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type PurchasesModule = any;

function load(): PurchasesModule | null {
  try {
    // Resolved at runtime so a build without the package still bundles.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-purchases').default ?? null;
  } catch {
    return null;
  }
}

/** True when the package is compiled in and a key exists for this platform. */
export function isAvailable(): boolean {
  return load() !== null && apiKey() !== null;
}

const millis = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
};

/**
 * RevenueCat's CustomerInfo, reduced to the six facts the app acts on.
 *
 * `isActive` already accounts for grace periods and billing retry, so it is the
 * one flag that decides whether the assistant works — never the expiry date,
 * which is in the past for the whole of a grace period.
 */
function toEntitlement(info: any): Entitlement {
  const active = info?.entitlements?.active?.[entitlementId()];
  if (!active) return FREE;

  const store: Entitlement['store'] =
    active.store === 'APP_STORE' || active.store === 'MAC_APP_STORE'
      ? 'app-store'
      : active.store === 'PLAY_STORE'
        ? 'play-store'
        : 'sandbox';

  return {
    active: true,
    // We got an answer out of the SDK, so this is a fact rather than a guess —
    // including when RevenueCat served it from its own offline cache.
    known: true,
    // Which plan the active entitlement came from, matched against the product
    // identifiers we sell rather than sniffed for the substring "year" — a
    // product named `pro_yearly_promo` matched that, and `annual` did not.
    plan: planForProduct(String(active.productIdentifier ?? '')),
    tier: tierFor(planForProduct(String(active.productIdentifier ?? '')) ?? 'ridik_monthly'),
    renewsAt: millis(active.expirationDate),
    willRenew: active.willRenew === true,
    since: millis(active.originalPurchaseDate),
    // RevenueCat reports the grace period as still-active-but-not-renewing with
    // a billing issue; `billingIssueDetectedAt` is the only honest signal.
    inGracePeriod: Boolean(active.billingIssueDetectedAt),
    store,
  };
}

/**
 * Which allowance a plan buys, read from the package it came in.
 *
 * Keyed on the *package* rather than sniffed out of the product identifier.
 * The old version matched substrings — `id.includes('unlimited')` — which is a
 * rule the dashboard has no idea it is bound by: name a product
 * `ridik_unlimited_trial` and it silently hands out the largest allowance in
 * the app. A closed map cannot do that.
 *
 * Anything unrecognised is `base`, the smallest. A mis-configured product
 * should under-serve and be complained about, never over-serve and be
 * discovered on the invoice.
 */
/**
 * The plan a store product identifier belongs to, or null.
 *
 * The store reports what was *bought* as a product id (`ridik_pro_yearly`),
 * while the offering exposes what is *for sale* as a package key
 * (`pro_yearly`). They are deliberately different strings, so restoring a
 * purchase has to come back through this rather than through `packageKeyFor`.
 */
/**
 * How Play should replace one subscription with another, per direction.
 *
 * Strings rather than the SDK's enum: importing `STORE_REPLACEMENT_MODE` would
 * pull the native module into this file's type graph, and these are the exact
 * values it holds. `revenuecat-config.test.ts` pins them.
 */
const REPLACEMENT_MODE: Record<Exclude<PlanChange, 'same'>, string> = {
  upgrade: 'CHARGE_PRORATED_PRICE',
  downgrade: 'DEFERRED',
  crossgrade: 'WITH_TIME_PRORATION',
};

const PRODUCT_FOR: Record<PlanId, string> = {
  ridik_monthly: 'ridik_monthly',
  ridik_yearly: 'ridik_yearly',
  pro_monthly: 'ridik_pro_monthly',
  pro_yearly: 'ridik_pro_yearly',
};

function planForProduct(productId: string): PlanId | null {
  return PLAN_IDS.find((plan) => PRODUCT_FOR[plan] === productId) ?? null;
}

function toPlan(pkg: any): Plan | null {
  const key = String(pkg?.identifier ?? '');
  const id = PLAN_IDS.find((plan) => packageKeyFor(plan) === key) ?? null;
  // A package the app does not know is skipped rather than guessed at: an
  // offering can carry an experiment or a legacy row, and rendering one as a
  // plan would sell an allowance nothing here can enforce.
  if (!id) return null;
  const tier = tierFor(id);
  return {
    id,
    tier,
    title: titleFor(id),
    // The store's own localised string, in the user's currency. Never rebuilt
    // from the numeric price: that is how an app ends up showing "$4.99" to
    // someone being charged in leva.
    price: String(pkg.product?.priceString ?? ''),
    period: PLAN_PERIOD[id],
    // The same figure as a number, for the one thing the store cannot answer:
    // what a yearly plan costs per month. `money.ts` owns that arithmetic and
    // nothing else may do it.
    amount: typeof pkg.product?.price === 'number' ? pkg.product.price : null,
    currency: pkg.product?.currencyCode ? String(pkg.product.currencyCode) : null,
  };
}

/**
 * Record who this install is, for the backend to verify.
 *
 * `ASSISTANT_TOKEN_STORE_KEY` was read in two places and written by nobody, so a
 * store build's `getToken()` returned null for ever: the hosted provider
 * reported itself unconfigured and every turn fell to the offline matcher. A
 * deployed backend would not have fixed it — the app had nothing to present.
 *
 * The id is RevenueCat's app user id. It is an identifier rather than a
 * credential, and `server/revenuecat.ts` says at length what that does and does
 * not buy: the server never trusts a client's claim about its *entitlement*, it
 * asks RevenueCat with its own secret key. What the id gives the server is
 * someone to ask about.
 *
 * Failure is deliberately silent. This runs inside `configure()` during
 * bootstrap, and a keychain that will not open must not stop billing from coming
 * up — the turn that needed a token degrades exactly as an unconfigured one does.
 */
async function rememberIdentity(Purchases: PurchasesModule): Promise<void> {
  try {
    const id = await (Purchases as unknown as { getAppUserID(): Promise<string> }).getAppUserID();
    if (!id) return;
    /*
     * Required here rather than imported at the top, and not for style.
     * `@/features/voice/mode` imports `expo-secure-store`, which ships
     * untransformed ESM, and this module is loaded by the `logic` test project —
     * plain Node, no transform for node_modules. A top-level import made
     * `revenuecat-config.test.ts` fail to parse at all. Inside the function the
     * module is only reached on a device, where the SDK exists; the same trick
     * and the same reason as `services/notifications/responses.ts`.
     */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mode = require('@/features/voice/mode') as typeof import('@/features/voice/mode');
    await mode.writeSecret(mode.ASSISTANT_TOKEN_STORE_KEY, id);
  } catch (error) {
    log.warn('could not record the billing identity', error);
  }
}

export function createRevenueCatProvider(): BillingProvider {
  return {
    name: 'revenuecat',
    // Only constructed when `isAvailable()` says the SDK is compiled in and
    // keyed, so this is the build that can take money — and therefore the build
    // where a free entitlement means somebody chose not to pay.
    sells: true,

    async configure() {
      const Purchases = load();
      const key = apiKey();
      if (!Purchases || !key) return;
      await Purchases.configure({ apiKey: key });
      await rememberIdentity(Purchases);
      log.info('billing configured');
    },

    async plans() {
      const Purchases = load();
      if (!Purchases) return [];
      const offerings = await Purchases.getOfferings();
      const packages: any[] = offerings?.current?.availablePackages ?? [];
      return packages
        .map(toPlan)
        .filter((plan): plan is Plan => plan !== null)
        // The order the ladder is meant to be read in — the badged row leads,
        // so the expensive option anchors the cheap one rather than the other
        // way round. Sorting by price would invert that in every currency.
        .sort((a, b) => PLAN_IDS.indexOf(a.id) - PLAN_IDS.indexOf(b.id));
    },

    /**
     * Read off the offering's `metadata` in the RevenueCat dashboard, so the
     * selling points and the "best value" flag can be reworded without a
     * release. Anything malformed is ignored rather than rendered — a paywall
     * showing `[object Object]` is worse than one showing the built-in copy.
     */
    async marketing() {
      const Purchases = load();
      if (!Purchases) return null;
      const offerings = await Purchases.getOfferings();
      const meta = offerings?.current?.metadata as Record<string, unknown> | undefined;
      if (!meta) return null;

      const benefits = Array.isArray(meta.benefits)
        ? meta.benefits.filter((line): line is string => typeof line === 'string' && line.trim() !== '')
        : [];
      // Validated against the plans that exist rather than a hardcoded pair:
      // the dashboard can name any row, and a highlight pointing at a plan this
      // build does not sell must be ignored, not rendered as a badge on nothing.
      const highlight = PLAN_IDS.find((plan) => plan === meta.highlight) ?? null;
      return benefits.length === 0 && highlight === null ? null : { benefits, highlight };
    },

    async current() {
      const Purchases = load();
      if (!Purchases) return FREE;
      return toEntitlement(await Purchases.getCustomerInfo());
    },

    async purchase(plan, tier, from) {
      const Purchases = load();
      if (!Purchases) throw new Error('Purchases are not available in this build.');
      const offerings = await Purchases.getOfferings();
      const packages: any[] = offerings?.current?.availablePackages ?? [];
      // Both the period and the tier have to match: two products can share a
      // billing period and differ only in what they allow.
      const target = packages.find(
        (pkg) =>
          pkg?.identifier === packageKeyFor(plan) &&
          // Both have to match. The caller passes the tier it showed the user,
          // and buying a package whose tier has since changed in the dashboard
          // would charge for one allowance and grant another.
          tierFor(plan) === tier,
      );
      if (!target) throw new Error('That plan is not available right now.');

      /*
       * Changing plan is not the same call as buying one, and on Android the
       * difference is a second subscription.
       *
       * iOS does this for free: StoreKit sees both products in one subscription
       * group, cancels the old one, credits the unused time and charges the
       * difference. Nothing here has to ask. (It only works if the products
       * ARE in one group in App Store Connect — if they are not, the user ends
       * up paying for both, and no code can fix that.)
       *
       * Google does none of it. Without `oldProductIdentifier` Play treats the
       * purchase as unrelated and leaves the customer holding two live
       * subscriptions, billed for both, with an app that shows whichever
       * entitlement RevenueCat resolved. That is the failure this block exists
       * to prevent, and it costs the *user* money, which is the worst kind.
       *
       * The replacement mode is chosen per direction, and the choice is the
       * whole of the "fair but not generous" question:
       *
       *   upgrade    CHARGE_PRORATED_PRICE — takes effect now, the billing date
       *              does not move, and they pay only the difference for the
       *              days remaining. They get more allowance immediately and
       *              are charged for exactly what that is worth. Nothing is
       *              refunded and nothing is given away.
       *   downgrade  DEFERRED — they keep what they paid for until the period
       *              they already bought runs out, then drop. No refund, which
       *              is right: they had the larger allowance the whole time.
       *   crossgrade WITH_TIME_PRORATION — monthly to yearly at the same tier.
       *              The unused time becomes time on the new plan rather than
       *              money back, which is the only sane reading of "I want to
       *              pay for a year now".
       *
       * `CHARGE_FULL_PRICE` is the greedy option — it bills a whole new period
       * on top and hands back the old one as extra days. It is deliberately not
       * used.
       */
      const change = from ? planChange(from, plan) : 'same';
      const productChangeInfo =
        Platform.OS === 'android' && from && change !== 'same'
          ? {
              oldProductIdentifier: PRODUCT_FOR[from],
              replacementMode: REPLACEMENT_MODE[change],
            }
          : null;

      try {
        const { customerInfo } = await Purchases.purchasePackage(
          target,
          null,
          productChangeInfo,
        );
        return toEntitlement(customerInfo);
      } catch (error: any) {
        // Backing out of the store sheet is not a failure, and must not raise
        // an error banner over a screen the user deliberately dismissed.
        if (error?.userCancelled) return this.current();
        throw error;
      }
    },

    async restore() {
      const Purchases = load();
      if (!Purchases) throw new Error('Purchases are not available in this build.');
      const info = await Purchases.restorePurchases();
      // A restore can alias this install onto the identity that made the
      // original purchase, so the id captured at `configure()` may now be the
      // wrong one. Re-reading it here is the difference between a restored
      // subscriber whose backend requests are attributed to them and one whose
      // requests are attributed to a stranger with no entitlement.
      await rememberIdentity(Purchases);
      return toEntitlement(info);
    },

    /**
     * How many top-ups this user has ever bought.
     *
     * `nonSubscriptionTransactions` is RevenueCat's own ledger of consumables,
     * and it is deliberately the only source for this number: the balance the
     * app enforces is `bought - spent`, the spent half lives on the device, and
     * a device that can edit both halves can mint requests on the operator's
     * key. Counted rather than summed, because one transaction is one purchase
     * whatever it cost in the local currency.
     */
    async topUpsPurchased() {
      const Purchases = load();
      if (!Purchases) return 0;
      try {
        const info: any = await Purchases.getCustomerInfo();
        const all: any[] = info?.nonSubscriptionTransactions ?? [];
        return all.filter((tx) => String(tx?.productIdentifier ?? '') === TOPUP_PRODUCT).length;
      } catch (error) {
        // The count is a balance, and an unreadable balance must read as zero
        // rather than as "unchanged": guessing upwards here is free requests.
        log.warn('could not read the top-up count', { error });
        return 0;
      }
    },

    /**
     * The consumable, fetched by product id rather than out of an offering.
     *
     * An offering is a *choice between plans* — RevenueCat's own guidance is
     * that consumables need not sit in one, and putting it there would make it
     * a fifth thing the paywall has to filter out of its two cards. Asking for
     * the product directly also means the top-up needs no dashboard change to
     * work, so it cannot be broken by somebody rearranging the offering.
     */
    async topUpProduct() {
      const Purchases = load();
      if (!Purchases) return null;
      try {
        const products: any[] = await Purchases.getProducts([TOPUP_PRODUCT], 'NON_SUBSCRIPTION');
        const product = products.find(
          (item) => String(item?.identifier ?? '') === TOPUP_PRODUCT,
        );
        if (!product) return null;
        return {
          price: String(product.priceString ?? ''),
          amount: typeof product.price === 'number' ? product.price : null,
          currency: product.currencyCode ? String(product.currencyCode) : null,
        };
      } catch (error) {
        log.warn('could not read the top-up product', { error });
        return null;
      }
    },

    async topUp() {
      const Purchases = load();
      if (!Purchases) throw new Error('Purchases are not available in this build.');
      const products: any[] = await Purchases.getProducts([TOPUP_PRODUCT], 'NON_SUBSCRIPTION');
      const product = products.find((item) => String(item?.identifier ?? '') === TOPUP_PRODUCT);
      if (!product) throw new Error('Top-ups are not available right now.');

      try {
        await Purchases.purchaseStoreProduct(product);
      } catch (error: any) {
        // Backing out of the store sheet is not a failure. The count is asked
        // for again either way, so a cancel simply reports what was already
        // owned.
        if (error?.userCancelled) return this.topUpsPurchased!();
        throw error;
      }
      // Asked again rather than incremented locally. The store is the authority
      // on what was bought, and a purchase that succeeded on the device but not
      // at the till must not add to the balance.
      return this.topUpsPurchased!();
    },

    manageUrl() {
      return Platform.OS === 'ios'
        ? 'https://apps.apple.com/account/subscriptions'
        : 'https://play.google.com/store/account/subscriptions';
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
