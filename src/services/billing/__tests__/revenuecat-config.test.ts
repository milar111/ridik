/**
 * The RevenueCat provider reads three dashboard-owned strings out of
 * `app.config.ts` — the two publishable SDK keys and the entitlement id.
 *
 * The entitlement is the one that has to be guarded by a test: it is a single
 * string, it decides whether anyone is subscribed at all, and getting it wrong
 * fails *silently* — every customer simply looks like a free user. Renaming the
 * entitlement in RevenueCat must not need a release, and an unset value must
 * keep meaning `assistant`, which is what shipped.
 */
import { FREE } from '../entitlement';

const mockExtra: { revenueCat?: Record<string, string> } = {};

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { extra: mockExtra };
    },
  },
}));

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

/** A CustomerInfo carrying exactly one active entitlement, under `id`. */
const customerInfo = (id: string) => ({
  entitlements: {
    active: {
      [id]: {
        productIdentifier: 'ridik_standard_monthly',
        store: 'APP_STORE',
        expirationDate: '2026-09-01T00:00:00.000Z',
        originalPurchaseDate: '2026-08-01T00:00:00.000Z',
        willRenew: true,
      },
    },
  },
});

const mockGetCustomerInfo = jest.fn();

jest.mock(
  'react-native-purchases',
  () => ({ __esModule: true, default: { getCustomerInfo: () => mockGetCustomerInfo() } }),
  { virtual: true },
);

// Imported after the mocks so the module under test sees them.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRevenueCatProvider, isAvailable } = require('../revenuecat');

beforeEach(() => {
  for (const key of Object.keys(mockExtra)) delete (mockExtra as Record<string, unknown>)[key];
  mockGetCustomerInfo.mockReset();
});

describe('revenuecat configuration', () => {
  it('defaults to the entitlement that shipped when config says nothing', async () => {
    mockGetCustomerInfo.mockResolvedValue(customerInfo('assistant'));
    const entitlement = await createRevenueCatProvider().current();
    expect(entitlement.active).toBe(true);
    // `ridik_standard_monthly` is not a product this build sells, so the tier
    // falls to the SMALLEST rather than a middle default. A mis-configured
    // product should under-serve and be complained about; over-serving is
    // discovered on the invoice.
    expect(entitlement.tier).toBe('base');
  });

  it('honours a renamed entitlement from extra.revenueCat.entitlement', async () => {
    mockExtra.revenueCat = { entitlement: 'Ridik Pro' };
    mockGetCustomerInfo.mockResolvedValue(customerInfo('Ridik Pro'));
    expect((await createRevenueCatProvider().current()).active).toBe(true);
  });

  it('is not subscribed when the configured entitlement is absent', async () => {
    mockExtra.revenueCat = { entitlement: 'Ridik Pro' };
    mockGetCustomerInfo.mockResolvedValue(customerInfo('assistant'));
    expect(await createRevenueCatProvider().current()).toEqual(FREE);
  });

  it('treats a blank entitlement as unset rather than as a real identifier', async () => {
    mockExtra.revenueCat = { entitlement: '   ' };
    mockGetCustomerInfo.mockResolvedValue(customerInfo('assistant'));
    expect((await createRevenueCatProvider().current()).active).toBe(true);
  });

  it('is unavailable without a key for this platform, and available with one', () => {
    mockExtra.revenueCat = { android: 'goog_xxx' };
    expect(isAvailable()).toBe(false);
    mockExtra.revenueCat = { ios: 'appl_xxx' };
    expect(isAvailable()).toBe(true);
  });
});
