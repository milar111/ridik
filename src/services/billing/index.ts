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
import { createRevenueCatProvider, isAvailable as storeIsAvailable } from './revenuecat';

const log = createLogger('billing');

registerBootstrapStep({
  name: 'billing',
  // Not critical: a store that will not start is a reason to withhold the
  // assistant, never a reason to withhold the notes the user already wrote.
  async run() {
    const provider = storeIsAvailable() ? createRevenueCatProvider() : createDevelopmentProvider();
    registerBillingProvider(provider);
    await configureBilling();
    log.info('billing ready', { provider: provider.name });
  },
});

export {
  availablePlans,
  currentEntitlement,
  describePlan,
  describeRenewal,
  manageSubscriptionUrl,
  purchasePlan,
  restorePurchases,
  billingProviderName,
  FREE,
  type Entitlement,
  type Plan,
  type PlanId,
} from './entitlement';
