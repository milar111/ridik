/**
 * A store that only exists on your machine.
 *
 * Registered when the real one is not available — no `react-native-purchases`
 * compiled in, or no RevenueCat key for this platform — which is every
 * simulator build until the products exist in App Store Connect and Play
 * Console. Without it the paywall is a screen with nothing on it and the
 * subscription state can never be looked at, so none of it can be reviewed
 * before the accounts are open.
 *
 * It is not a fake purchase and must never be mistaken for one. It writes a
 * flag to this device's own settings, nothing leaves the phone, no money moves,
 * and every screen that shows a plan says where the plan came from. It exists
 * so the flow can be walked end to end.
 *
 * It never ships: `isAvailable()` in `revenuecat.ts` wins whenever the real
 * store is there, and `startup/register.ts` prefers it.
 */
import { now } from '@/core/clock';
import { createLogger } from '@/core/logger';
import { getRepositories } from '@/repositories';
import {
  FREE,
  type BillingProvider,
  type Entitlement,
  type Plan,
  type PlanId,
  type PlanTier,
} from './entitlement';

const log = createLogger('billing/development');

const DAY = 86_400_000;

/**
 * Prices are obviously placeholders and say so. Real ones come from the store,
 * already formatted in the buyer's currency — this provider cannot know that,
 * and inventing a plausible "€4.99" would be the one thing here that could
 * mislead someone reviewing the screen.
 */
const PLANS: Plan[] = [
  { id: 'monthly', tier: 'light', title: 'Light', price: '—', period: 'month', note: 'Sandbox' },
  { id: 'monthly', tier: 'standard', title: 'Standard', price: '—', period: 'month', note: 'Sandbox' },
  { id: 'yearly', tier: 'unlimited', title: 'Unlimited', price: '—', period: 'year', note: 'Sandbox' },
];

type Stored = { plan: PlanId; tier: PlanTier; since: number; renewsAt: number; willRenew: boolean };

function parse(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Stored>;
    if (value.plan !== 'monthly' && value.plan !== 'yearly') return null;
    if (value.tier !== 'light' && value.tier !== 'standard' && value.tier !== 'unlimited') return null;
    if (typeof value.renewsAt !== 'number' || typeof value.since !== 'number') return null;
    return {
      plan: value.plan,
      tier: value.tier,
      since: value.since,
      renewsAt: value.renewsAt,
      willRenew: value.willRenew !== false,
    };
  } catch {
    return null;
  }
}

export function createDevelopmentProvider(): BillingProvider {
  const read = async (): Promise<Stored | null> =>
    parse(await getRepositories().settings.get('sandboxSubscription'));

  const write = async (value: Stored | null): Promise<void> => {
    await getRepositories().settings.set(
      'sandboxSubscription',
      value === null ? null : JSON.stringify(value),
    );
  };

  const toEntitlement = (stored: Stored | null): Entitlement => {
    if (!stored) return FREE;
    // Expiry is honoured even here, so the lapsed state can be reviewed by
    // waiting rather than by editing the database.
    if (stored.renewsAt <= now()) return FREE;
    return {
      active: true,
      plan: stored.plan,
      tier: stored.tier,
      renewsAt: stored.renewsAt,
      willRenew: stored.willRenew,
      since: stored.since,
      inGracePeriod: false,
      store: 'sandbox',
    };
  };

  return {
    name: 'development',

    async configure() {
      log.warn('no store is configured; purchases are local to this device and buy nothing');
    },

    async plans() {
      return PLANS;
    },

    async marketing() {
      // No dashboard to read. The app's own copy stands.
      return null;
    },

    async current() {
      return toEntitlement(await read());
    },

    async purchase(plan, tier) {
      const at = now();
      const existing = await read();
      const stored: Stored = {
        plan,
        tier,
        since: existing?.since ?? at,
        renewsAt: at + (plan === 'yearly' ? 365 * DAY : 30 * DAY),
        willRenew: true,
      };
      await write(stored);
      return toEntitlement(stored);
    },

    async restore() {
      // Nothing to restore from: there is no receipt and no account, only this
      // device's own row. Returning what is here is the honest answer.
      return toEntitlement(await read());
    },

    manageUrl() {
      return 'https://apps.apple.com/account/subscriptions';
    },
  };
}
