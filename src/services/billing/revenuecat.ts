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
 *      then an entitlement called `assistant` in RevenueCat with both attached,
 *      and an offering whose packages are the monthly and yearly ones.
 *   3. Put the two public SDK keys in `app.config.ts` under
 *      `extra.revenueCat = { ios, android }`. They are publishable keys and
 *      belong in the build; the secret key never goes near the app.
 *   4. `npx expo prebuild --clean && npx expo run:ios` / `run:android`.
 * Nothing else changes: `isAvailable()` starts returning true and the startup
 * registration picks this over the development provider.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { createLogger } from '@/core/logger';
import {
  FREE,
  type BillingProvider,
  type Entitlement,
  type Plan,
  type PlanId,
  type PlanTier,
} from './entitlement';

const log = createLogger('billing/revenuecat');

/** The entitlement identifier configured in the RevenueCat dashboard. */
const ENTITLEMENT = 'assistant';

/** Package identifiers inside the offering. RevenueCat's own conventions. */
const PACKAGE_FOR: Record<PlanId, string> = { monthly: '$rc_monthly', yearly: '$rc_annual' };

type Keys = { ios?: string; android?: string };

function apiKey(): string | null {
  const extra = (Constants.expoConfig?.extra ?? {}) as { revenueCat?: Keys };
  const key = Platform.OS === 'ios' ? extra.revenueCat?.ios : extra.revenueCat?.android;
  return key?.trim() ? key.trim() : null;
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
  const active = info?.entitlements?.active?.[ENTITLEMENT];
  if (!active) return FREE;

  const store: Entitlement['store'] =
    active.store === 'APP_STORE' || active.store === 'MAC_APP_STORE'
      ? 'app-store'
      : active.store === 'PLAY_STORE'
        ? 'play-store'
        : 'sandbox';

  return {
    active: true,
    plan: String(active.productIdentifier ?? '').includes('year') ? 'yearly' : 'monthly',
    tier: tierFor(String(active.productIdentifier ?? '')),
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
 * Which allowance a product buys, read from its identifier.
 *
 * The convention is that the product id contains the tier — `ridik_standard_monthly`.
 * Anything unrecognised is treated as the middle tier rather than as unlimited:
 * a mis-named product should under-serve and be noticed, never hand out an
 * uncapped assistant by accident.
 */
function tierFor(productId: string): PlanTier {
  const id = productId.toLowerCase();
  if (id.includes('unlimited')) return 'unlimited';
  if (id.includes('light')) return 'light';
  return 'standard';
}

function toPlan(pkg: any): Plan | null {
  const id: PlanId | null =
    pkg?.identifier === PACKAGE_FOR.yearly
      ? 'yearly'
      : pkg?.identifier === PACKAGE_FOR.monthly
        ? 'monthly'
        : null;
  if (!id) return null;
  const tier = tierFor(String(pkg.product?.identifier ?? pkg.identifier ?? ''));
  return {
    id,
    tier,
    title: tier[0]!.toUpperCase() + tier.slice(1),
    // The store's own localised string, in the user's currency. Never rebuilt
    // from the numeric price: that is how an app ends up showing "$4.99" to
    // someone being charged in leva.
    price: String(pkg.product?.priceString ?? ''),
    period: id === 'yearly' ? 'year' : 'month',
  };
}

export function createRevenueCatProvider(): BillingProvider {
  return {
    name: 'revenuecat',

    async configure() {
      const Purchases = load();
      const key = apiKey();
      if (!Purchases || !key) return;
      await Purchases.configure({ apiKey: key });
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
        // Monthly first: it is the lower commitment and the one most people
        // start on. Ordering by price would put yearly first in every currency.
        .sort((a, b) => (a.id === 'monthly' ? -1 : b.id === 'monthly' ? 1 : 0));
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
      const highlight = meta.highlight === 'monthly' || meta.highlight === 'yearly' ? meta.highlight : null;
      return benefits.length === 0 && highlight === null ? null : { benefits, highlight };
    },

    async current() {
      const Purchases = load();
      if (!Purchases) return FREE;
      return toEntitlement(await Purchases.getCustomerInfo());
    },

    async purchase(plan, tier) {
      const Purchases = load();
      if (!Purchases) throw new Error('Purchases are not available in this build.');
      const offerings = await Purchases.getOfferings();
      const packages: any[] = offerings?.current?.availablePackages ?? [];
      // Both the period and the tier have to match: two products can share a
      // billing period and differ only in what they allow.
      const target = packages.find(
        (pkg) =>
          pkg?.identifier === PACKAGE_FOR[plan] &&
          tierFor(String(pkg?.product?.identifier ?? '')) === tier,
      );
      if (!target) throw new Error('That plan is not available right now.');

      try {
        const { customerInfo } = await Purchases.purchasePackage(target);
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
      return toEntitlement(await Purchases.restorePurchases());
    },

    manageUrl() {
      return Platform.OS === 'ios'
        ? 'https://apps.apple.com/account/subscriptions'
        : 'https://play.google.com/store/account/subscriptions';
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
