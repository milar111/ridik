/**
 * The store that only exists on your machine, and what it must refuse to do
 * once it is no longer on your machine.
 *
 * This provider is registered whenever the real one is missing — and "missing"
 * includes the way it goes missing by accident. `app.config.ts` defaults both
 * RevenueCat SDK keys to `''`, so a release built without
 * `EXPO_PUBLIC_REVENUECAT_IOS_KEY` set has no key, `revenuecat.isAvailable()`
 * is false, and this file is what ships. In that build the paywall's Buy button
 * wrote a local row that `current()` reported as a live Unlimited subscription:
 * an uncapped assistant, granted by tapping a button, with no money moving and
 * a "Sandbox" note as the only thing in the way. A badge is not an enforcement
 * mechanism.
 */
const mockSettings: Record<string, string | null> = {};

jest.mock('@/repositories', () => ({
  getRepositories: () => ({
    settings: {
      get: async (key: string) => mockSettings[key] ?? null,
      set: async (key: string, value: string | null) => {
        mockSettings[key] = value;
        return value;
      },
    },
  }),
}));

import type { BillingProvider } from '../entitlement';

/** Builds the provider with `__DEV__` pinned, which it reads at module load. */
function providerFor(isDev: boolean): BillingProvider {
  let made: BillingProvider | null = null;
  const globals = globalThis as { __DEV__?: boolean };
  const before = globals.__DEV__;
  globals.__DEV__ = isDev;
  try {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      made = (require('../development') as typeof import('../development')).createDevelopmentProvider();
    });
  } finally {
    if (before === undefined) delete globals.__DEV__;
    else globals.__DEV__ = before;
  }
  return made!;
}

beforeEach(() => {
  for (const key of Object.keys(mockSettings)) delete mockSettings[key];
});

describe('on a machine somebody is developing on', () => {
  it('grants a local plan so the paywall can be walked end to end', async () => {
    const provider = providerFor(true);

    const entitlement = await provider.purchase('yearly', 'unlimited');

    expect(entitlement).toMatchObject({ active: true, tier: 'unlimited', store: 'sandbox' });
    await expect(provider.current()).resolves.toMatchObject({ active: true });
  });

  it('has something to show on the paywall', async () => {
    await expect(providerFor(true).plans()).resolves.not.toHaveLength(0);
  });
});

describe('in a release build that lost its store keys', () => {
  it('cannot be talked into granting a plan', async () => {
    const provider = providerFor(false);

    await expect(provider.purchase('yearly', 'unlimited')).rejects.toThrow(/not available/i);
  });

  /* A row written by a debug build on the same device must not survive into a
     release one as a subscription. */
  it('ignores a sandbox row left behind by a debug build', async () => {
    await providerFor(true).purchase('yearly', 'unlimited');
    expect(mockSettings.sandboxSubscription).toBeTruthy();

    await expect(providerFor(false).current()).resolves.toMatchObject({ active: false });
    await expect(providerFor(false).restore()).resolves.toMatchObject({ active: false });
  });

  /* An empty paywall is the honest rendering of a build with no store behind
     it. Rows that look buyable and are not is the dishonest one. */
  it('offers nothing for sale', async () => {
    await expect(providerFor(false).plans()).resolves.toHaveLength(0);
  });

  /* Whatever it answers, it answers knowably: this is not a store that failed
     to reply, it is a build with no store in it, and the money path treats
     those two completely differently. */
  it('answers knowably rather than as an unreachable store', async () => {
    await expect(providerFor(false).current()).resolves.toMatchObject({ known: true });
  });

  it('never reports itself as able to sell', () => {
    expect(providerFor(false).sells).toBe(false);
    expect(providerFor(true).sells).toBe(false);
  });
});
