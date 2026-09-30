/**
 * Picks which store the app is talking to, once, at startup.
 *
 * The real one whenever it can be: `react-native-purchases` compiled in and a
 * RevenueCat key for this platform. Otherwise the development provider, so the
 * paywall and the subscription screen are reviewable on a simulator instead of
 * being blank until the store accounts exist.
 *
 * Registering something always is the point. The previous version registered
 * nothing when billing was unconfigured, and every screen about money then
 * rendered empty — which is indistinguishable from being broken.
 */
import { createLogger } from '@/core/logger';
import { registerBootstrapStep } from '@/startup/bootstrap';

import { configureBilling, registerBillingProvider } from './entitlement';
import { createDevelopmentProvider } from './development';
import {
  createRevenueCatProvider,
  isAvailable as storeIsAvailable,
  unavailableReason,
} from './revenuecat';

const log = createLogger('billing');

declare const __DEV__: boolean | undefined;

const RELEASE_BUILD =
  typeof __DEV__ !== 'undefined' ? !__DEV__ : process.env.NODE_ENV === 'production';

registerBootstrapStep({
  name: 'billing',
  // Not critical: a store that will not start is a reason to withhold the
  // assistant, never a reason to withhold the notes the user already wrote.
  async run() {
    const store = storeIsAvailable();
    const provider = store ? createRevenueCatProvider() : createDevelopmentProvider();
    registerBillingProvider(provider);
    await configureBilling();

    if (!store && RELEASE_BUILD) {
      // The failure this catches is a missing environment variable, not a bug:
      // `app.config.ts` defaults both RevenueCat keys to `''`, so a release
      // built without them registers a provider that cannot sell and reports
      // `sells: false`. The money path does not trust `sells` alone (see
      // `pipeline.ts`), but a release in this state still cannot take a
      // payment and has to say so loudly.
      log.error('release build has no store configured; nothing can be sold', {
        provider: provider.name,
        // The *reason*, not just the fact — typically a Web Billing key the
        // native SDK will not take — so nobody goes looking in the paywall.
        reason: unavailableReason(),
      });
      return;
    }
    log.info('billing ready', { provider: provider.name });
  },
});

export { unavailableReason as storeUnavailableReason } from './revenuecat';
export {
  availablePlans,
  currentEntitlement,
  describeBillingPeriod,
  describePlan,
  describePlanAllowance,
  describeRenewal,
  isStoreBuild,
  manageSubscriptionUrl,
  purchasePlan,
  restorePurchases,
  billingProviderName,
  FREE,
  UNKNOWN,
  type Entitlement,
  type Plan,
  HIGHLIGHTED_PLAN,
  PLAN_IDS,
  type PlanId,
} from './entitlement';

export {
  describeTrial,
  trialSpent,
  resolveAssistantBudget,
  TRIAL_LIMIT_MESSAGE,
  TRIAL_SPENT_MESSAGE,
  TRIAL_TOTAL_REQUESTS,
  TRIAL_TOTAL_TOKENS,
  type AssistantBudget,
} from './allowance';
