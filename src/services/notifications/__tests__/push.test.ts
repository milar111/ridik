/**
 * What the push service is allowed to be told.
 *
 * `briefing_line` and `briefing_headline` read like telemetry and are not:
 * they are `composeVisual`'s own sentences, which interpolate real event
 * titles, task titles, habit names and the names of people in the CRM. Sending
 * them is personal data leaving the phone to a third party — and it was
 * happening from a bootstrap step, so on a fresh install the user's day was on
 * onesignal.com while they were still reading "Stays on this phone", and it
 * stayed there after they declined.
 *
 * The gate is therefore asserted in both directions, plus the withdrawal: a
 * revocation made in an earlier session has to take the old tags down, because
 * nothing else ever will.
 */
const mockExtra: { oneSignal?: { appId?: string } } = {};

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { extra: mockExtra };
    },
  },
}));

jest.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

jest.mock('expo-router', () => ({ router: { navigate: () => {} } }));
jest.mock('@/startup/bootstrap', () => ({ registerBootstrapStep: () => {} }));
jest.mock('../local', () => ({
  configureNotifications: async () => {},
  ensurePermission: async () => ({ ok: true, value: undefined }),
}));

const mockAddTags = jest.fn();
const mockRemoveTags = jest.fn();
const mockOptedIn = jest.fn(async () => true);
const mockInitialize = jest.fn();

jest.mock(
  'react-native-onesignal',
  () => ({
    OneSignal: {
      initialize: (...args: unknown[]) => mockInitialize(...args),
      Notifications: { addEventListener: () => {} },
      User: {
        addTags: (...args: unknown[]) => mockAddTags(...args),
        removeTags: (...args: unknown[]) => mockRemoveTags(...args),
        pushSubscription: {
          getOptedInAsync: () => mockOptedIn(),
          optIn: () => {},
          optOut: () => {},
        },
      },
    },
  }),
  { virtual: true },
);

const mockBriefing = {
  ok: true as const,
  value: {
    data: {
      date: '2026-03-09',
      zone: 'Europe/Sofia',
      events: [],
      dueTasks: [],
      overdueTasks: [],
      streaksAtRisk: [],
      commitments: [],
    },
    bullets: [
      { icon: 'calendar', text: 'Oncology follow-up at 09:30.' },
      { icon: 'clear', text: 'Nothing due today.' },
      { icon: 'clear', text: 'No promises outstanding.' },
    ],
  },
};
jest.mock('@/features/briefing', () => ({ generateBriefing: async () => mockBriefing }));

let mockConsent: 'unset' | 'granted' | 'declined' = 'unset';
let mockConsentUnreadable = false;
jest.mock('@/repositories', () => ({
  getRepositories: () => ({
    settings: {
      get: async () => {
        if (mockConsentUnreadable) throw new Error('database is locked');
        return mockConsent;
      },
    },
  }),
}));

/**
 * The first tag upload is deliberately not awaited by `initialisePush` —
 * startup must not wait on seven repository queries — so the test has to.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

/* Imported per test: `initialisePush` is idempotent by design, so the module
   registry has to be reset to run it again under a different answer. */
async function boot(consent: typeof mockConsent) {
  mockConsent = consent;
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const push = require('../push') as typeof import('../push');
  await push.initialisePush();
  await flush();
  return push;
}

beforeEach(() => {
  mockExtra.oneSignal = { appId: 'an-app-id' };
  mockConsentUnreadable = false;
  mockAddTags.mockClear();
  mockRemoveTags.mockClear();
  mockInitialize.mockClear();
  mockOptedIn.mockResolvedValue(true);
});

describe('the briefing tags', () => {
  it.each(['unset', 'declined'] as const)(
    'uploads nothing about the day while consent is %p',
    async (consent) => {
      await boot(consent);

      expect(mockInitialize).toHaveBeenCalledWith('an-app-id');
      expect(mockAddTags).not.toHaveBeenCalled();
    },
  );

  it('uploads them once consent has been given', async () => {
    await boot('granted');

    expect(mockAddTags).toHaveBeenCalledTimes(1);
    const tags = mockAddTags.mock.calls[0]![0] as Record<string, string>;
    expect(tags.briefing_headline).toBe('Oncology follow-up at 09:30.');
  });

  /* The self-healing half: `published` is module state, so a grant made and
     revoked in an earlier session leaves nothing here that knows tags are out
     there. Withdrawing once per launch is what covers that. */
  it('takes back what an earlier session published', async () => {
    await boot('declined');

    expect(mockRemoveTags).toHaveBeenCalledTimes(1);
    expect(mockRemoveTags.mock.calls[0]![0]).toContain('briefing_line');
  });

  it('does not keep withdrawing them on every foreground', async () => {
    const push = await boot('declined');
    mockRemoveTags.mockClear();

    await push.refreshBriefingTags({ force: true });
    await push.refreshBriefingTags({ force: true });

    expect(mockRemoveTags).not.toHaveBeenCalled();
  });

  /* Opting out took the tags down and the very next foreground put them
     straight back, because nothing on the publish path read the subscription. */
  it('stays quiet after the user turns the briefing push off', async () => {
    const push = await boot('granted');
    expect(mockAddTags).toHaveBeenCalledTimes(1);

    await push.setPushEnabled(false);
    mockAddTags.mockClear();
    await push.refreshBriefingTags({ force: true });

    expect(mockAddTags).not.toHaveBeenCalled();
  });

  /* Fail closed: an answer that could not be read is not a yes. */
  it('publishes nothing when the consent row cannot be read', async () => {
    mockConsentUnreadable = true;
    await boot('granted');

    expect(mockAddTags).not.toHaveBeenCalled();
  });

  /* A build with no push project stays exactly as it was before this file
     existed: nothing initialised, nothing sent, nothing withdrawn. */
  it('does nothing at all without an App ID', async () => {
    delete mockExtra.oneSignal;
    await boot('granted');

    expect(mockInitialize).not.toHaveBeenCalled();
    expect(mockAddTags).not.toHaveBeenCalled();
    expect(mockRemoveTags).not.toHaveBeenCalled();
  });
});
