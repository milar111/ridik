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
  PLAN_IDS,
  isYearly,
  type BillingProvider,
  type Entitlement,
  type Plan,
  type PlanId,
  type PlanTier,
} from './entitlement';

const log = createLogger('billing/development');

const DAY = 86_400_000;

declare const __DEV__: boolean | undefined;

/**
 * Whether a local, money-free "purchase" may be granted at all.
 *
 * This provider is registered whenever the real store is missing, and "missing"
 * includes the way it goes missing by accident: a release build produced
 * without `EXPO_PUBLIC_REVENUECAT_IOS_KEY` set has no SDK key, so
 * `revenuecat.isAvailable()` is false and this file is what gets registered.
 * Without this guard the paywall in that build would write a local row that
 * `toEntitlement` reports as a live Unlimited subscription — an uncapped
 * assistant, granted by tapping Buy, with no money moving and a "Sandbox" note
 * as the only thing standing in the way. A badge is not an enforcement
 * mechanism, so the sandbox is switched off outside a debug build entirely.
 */
const SANDBOX_ALLOWED = typeof __DEV__ !== 'undefined' ? Boolean(__DEV__) : process.env.NODE_ENV !== 'production';

/**
 * Prices are obviously placeholders and say so. Real ones come from the store,
 * already formatted in the buyer's currency — this provider cannot know that,
 * and inventing a plausible "€4.99" would be the one thing here that could
 * mislead someone reviewing the screen.
 */
/**
 * The same four rows the real offering carries, in the same order, so the
 * paywall a reviewer sees on a simulator is the paywall a customer sees.
 *
 * Prices stay em-dashes. The store owns the localised string and inventing a
 * plausible "$4.99" here is the one thing on this screen that could mislead
 * somebody into thinking a number had been confirmed.
 */
const PLANS: Plan[] = [
  { id: 'pro_yearly', tier: 'pro', title: 'Ridik Pro', price: '—', period: 'year', note: 'Sandbox' },
  { id: 'pro_monthly', tier: 'pro', title: 'Ridik Pro', price: '—', period: 'month', note: 'Sandbox' },
  { id: 'ridik_yearly', tier: 'base', title: 'Ridik', price: '—', period: 'year', note: 'Sandbox' },
  { id: 'ridik_monthly', tier: 'base', title: 'Ridik', price: '—', period: 'month', note: 'Sandbox' },
];

type Stored = { plan: PlanId; tier: PlanTier; since: number; renewsAt: number; willRenew: boolean };

function parse(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Stored>;
    // Validated against the live lists rather than a second copy of them: a
    // sandbox row written by an older build must decode to null and be ignored,
    // not resurrect a tier this version no longer sells.
    if (!PLAN_IDS.includes(value.plan as PlanId)) return null;
    if (!(value.tier === 'base' || value.tier === 'pro')) return null;
    if (typeof value.renewsAt !== 'number' || typeof value.since !== 'number') return null;
    return {
      plan: value.plan as PlanId,
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
      known: true,
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
    // No money can move here, so nothing about a free entitlement in this build
    // is a decision the user made. The assistant keeps the developer caps it
    // has always had; the free-tier lock belongs to builds with a real store.
    sells: false,

    async configure() {
      if (!SANDBOX_ALLOWED) {
        log.error(
          'no store is configured in a release build; nothing can be sold and no plan can be granted',
        );
        return;
      }
      log.warn('no store is configured; purchases are local to this device and buy nothing');
    },

    async plans() {
      // A release build that reached this provider has no store behind it, so
      // there is genuinely nothing for sale. An empty paywall is the honest
      // rendering; a list of buyable-looking rows is not.
      return SANDBOX_ALLOWED ? PLANS : [];
    },

    async marketing() {
      // No dashboard to read. The app's own copy stands.
      return null;
    },

    async current() {
      // A row left behind by a debug build must not become a subscription in a
      // release one, so the stored state is not even read outside the sandbox.
      if (!SANDBOX_ALLOWED) return FREE;
      return toEntitlement(await read());
    },

    async purchase(plan, tier) {
      if (!SANDBOX_ALLOWED) {
        throw new Error('Purchases are not available in this build.');
      }
      const at = now();
      const existing = await read();
      const stored: Stored = {
        plan,
        tier,
        since: existing?.since ?? at,
        renewsAt: at + (isYearly(plan) ? 365 * DAY : 30 * DAY),
        willRenew: true,
      };
      await write(stored);
      return toEntitlement(stored);
    },

    async restore() {
      // Nothing to restore from: there is no receipt and no account, only this
      // device's own row. Returning what is here is the honest answer.
      if (!SANDBOX_ALLOWED) return FREE;
      return toEntitlement(await read());
    },

    manageUrl() {
      return 'https://apps.apple.com/account/subscriptions';
    },
  };
}
