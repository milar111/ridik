/**
 * The first-run disclosure, and the lid it is drawn under.
 *
 * Two things are worth holding in place here and they fail in opposite
 * directions. The screen has to *name the provider* — Guideline 5.1.2(i) is
 * specific about that, and "a third party" would pass a reading of the rule and
 * fail the point of it. And the gate has to be a gate: shown when nobody has
 * answered, gone the instant somebody has, and never shown again to a person
 * who said no. A gate that reappears is how a refusal turns into a nag, and a
 * gate that flashes on every launch is what a naive `useSetting` default does
 * while SQLite is still answering.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import * as consentModule from '@/llm/consent';
import { defaultSettings, type SettingsValues } from '@/repositories/settings';
import { FREE, registerBillingProvider, type BillingProvider } from '@/services/billing/entitlement';

import { ThemeProvider } from '../ThemeProvider';
import { ToastProvider } from '../components/Toast';

/**
 * Every company or server a single "Allow" covers. Held here rather than
 * imported wholesale so that adding a recipient is a two-file change with a
 * visible diff in both — see the test below, which proves this list is
 * complete against `consent.ts`.
 */
const ALL_PROVIDERS = [
  consentModule.ASSISTANT_PROVIDER,
  consentModule.WHISPER_PROVIDER,
  consentModule.ANALYTICS_PROVIDER,
  consentModule.CRASH_PROVIDER,
  consentModule.STORE_PROVIDER,
] as const;

/** `Ridik's own server` has an apostrophe; nothing here should be a pattern. */
const escapeForRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/* The real hooks, the real query keys, the real optimistic write path. Only the
   repository under them is faked, so what is under test is the screen. */
let mockStored: SettingsValues;
const mockSetMany = jest.fn();
jest.mock('@/repositories', () => ({
  getRepositories: () => ({
    db: {},
    settings: {
      getAll: async () => ({ ...mockStored }),
      get: async (key: string) => (mockStored as Record<string, unknown>)[key],
      set: async (key: string, value: unknown) => value,
      setMany: async (patch: Partial<SettingsValues>) => {
        mockSetMany(patch);
        mockStored = { ...mockStored, ...patch };
        return { ...mockStored };
      },
    },
  }),
}));

/* `@/features/voice/mode` binds the keychain at import. Which way this build
   reaches the assistant is one line of copy on the screen, and supplying it
   here keeps expo-secure-store out of a component test. */
let mockMode: 'hosted' | 'personal-key' | 'offline';
jest.mock('@/hooks/useAssistant', () => ({
  useAssistantMode: () => ({ data: mockMode, isLoading: false }),
}));

const mockRouterBack = jest.fn();
const mockRouterReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockRouterBack, replace: mockRouterReplace, canGoBack: () => true }),
}));

/* The welcome flow the gate now draws asks for permissions, and
   `@/hooks/useSystem` binds the keychain, the calendar and the speech
   recogniser at import time. Everything the ask rows read is supplied here so
   the *disclosure* stays what these suites are about. */
let mockLevel = 'denied';
jest.mock('@/hooks/useSystem', () => ({
  usePermissions: () => ({
    data: {
      microphone: { id: 'microphone', level: mockLevel, detail: '' },
      notifications: { id: 'notifications', level: mockLevel, detail: '' },
      calendar: { id: 'calendar', level: mockLevel, detail: '' },
      location: { id: 'location', level: mockLevel, detail: '' },
    },
    isLoading: false,
    isSuccess: true,
  }),
  useRequestPermission: () => ({ mutate: jest.fn(), isPending: false, variables: undefined }),
}));

import { ConsentGate, ConsentScreen } from '@/features/consent';
import ConsentRoute from '../../../app/consent';

/** A store, or the absence of one — the trial line only exists on a real one. */
const billing = (sells: boolean): BillingProvider => ({
  name: sells ? 'stub-store' : 'stub-personal',
  sells,
  configure: async () => {},
  plans: async () => [],
  marketing: async () => null,
  current: async () => FREE,
  purchase: async () => FREE,
  restore: async () => FREE,
  manageUrl: () => 'https://example.test',
});

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">
        <QueryClientProvider client={client}>
          <ToastProvider>{ui}</ToastProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  mockLevel = 'denied';
  mockStored = defaultSettings();
  mockMode = 'personal-key';
  mockSetMany.mockClear();
  mockRouterBack.mockClear();
  registerBillingProvider(billing(false));
});

describe('what the screen says', () => {
  /* The rule is not "disclose"; it is "name them". A screen that says "a third
     party" reads as evasive and is the exact wording review rejects. */
  it('names the provider rather than calling it a third party', async () => {
    await wrap(<ConsentScreen />);

    expect(await screen.findByText('Goes to Google')).toBeTruthy();
    expect(screen.queryByText(/third party/i)).toBeNull();
  });

  /* What stays, what goes, what is never sent — and the third one is the one
     people assume is false, so it is the one that must be on the screen. */
  /*
   * The screen leads with what stays, so that half is the heading and the
   * opening paragraph rather than a card. The two panels that *name a
   * recipient* stay above the fold; the elaboration on what stays and what is
   * never sent opens on request, which is the whole reason this screen stopped
   * being five hundred words of prose in front of a first run.
   */
  it('says what stays and what is never sent, not only what leaves', async () => {
    await wrap(<ConsentScreen />);

    expect(await screen.findByText('Your life stays on this phone')).toBeTruthy();
    expect(screen.getByText(/nothing to sign in to/i)).toBeTruthy();

    await fireEvent.press(screen.getByText('Exactly what is sent, and what never is'));
    expect(screen.getByText('Stays on this phone')).toBeTruthy();
    expect(screen.getByText('Never sent')).toBeTruthy();
  });

  /*
   * The line the expander must never cross.
   *
   * Collapsing reassurance is a kindness; collapsing the disclosure would make
   * this a screen that asks for consent without stating what to, which is the
   * specific thing Guideline 5.1.2(i) rejects for. Both panels that name a
   * recipient — the assistant, and the dictation service the audio reaches when
   * the phone has no offline voice — have to be readable before anyone taps
   * anything.
   */
  it('never hides a recipient behind the expander', async () => {
    await wrap(<ConsentScreen />);

    expect(await screen.findByText('Goes to Google')).toBeTruthy();
    expect(screen.getByText('The recording')).toBeTruthy();
    expect(screen.getByText(/to work out what you meant/)).toBeTruthy();
  });

  /**
   * One yes covers three companies, so all three have to be on the screen it
   * is given on.
   *
   * `Google` was the only name anywhere. The Whisper rung uploads the
   * *recording* — the most sensitive payload the app has — to OpenAI, and the
   * screen called it "the optional Whisper transcription", which names a model
   * and not a company; the briefing push hands `composeVisual`'s own sentence,
   * with real event titles and real people's names in it, to OneSignal, and
   * that was not mentioned at all. Both are behind this same grant.
   */
  it('names every company one yes covers, not only the assistant', async () => {
    await wrap(<ConsentScreen />);
    await screen.findByText('Goes to Google');

    /*
     * Enumerated from the module, not listed by hand.
     *
     * This assertion used to name OpenAI and OneSignal as literals, which made
     * it an allow-list: a *fifth* recipient could be added to `consent.ts`,
     * wired to a real network call, and this test would still pass — the exact
     * failure it exists to prevent, one provider later. Reading the constants
     * means the day somebody exports a sixth `*_PROVIDER` without putting a
     * sentence on this screen, this line goes red with that provider's name in
     * the diff.
     */
    for (const provider of ALL_PROVIDERS) {
      // `getAllBy`, not `getBy`: the assistant's name legitimately appears in
      // the panel heading, the panel body and the route line, and a provider
      // being on the screen *more than once* is not the failure this guards.
      expect(screen.getAllByText(new RegExp(escapeForRegExp(provider))).length).toBeGreaterThan(0);
    }
  });

  /**
   * And the enumeration has to be complete, or reading it proves nothing.
   *
   * `ALL_PROVIDERS` is written by hand in this file; `consent.ts` is where a
   * new recipient actually appears. This reads the module's own exports and
   * fails if one of them never made it into the list above — so the guard
   * cannot be defeated by forgetting to extend the guard.
   */
  it('has a provider list that covers every recipient consent.ts exports', () => {
    const exported = Object.entries(consentModule)
      .filter(([key, value]) => key.endsWith('_PROVIDER') && typeof value === 'string')
      .map(([, value]) => value as string);

    expect(exported.length).toBeGreaterThan(0);
    expect([...exported].sort()).toEqual([...ALL_PROVIDERS].sort());
  });

  /**
   * "The words of a request, and today's date" was roughly a tenth of the
   * truth. Every turn calls `buildLlmContext`, which puts today's and
   * tomorrow's events with their times and places, the timetable, open tasks
   * with due dates, note titles, list names, habit names, place labels,
   * spending categories and up to twenty-five people's names into the system
   * prompt — so "note the resistors" carries the user's colleagues and their
   * hospital appointment with it. A disclosure that understates is worse than
   * none, because it is the thing the grant was obtained with.
   */
  /*
   * Asserted against the whole screen rather than one text node, which is both
   * more robust and a stronger guarantee: what matters is that a person can
   * read every category, not which element happens to hold it. The index used
   * to be one sixty-word sentence and is now a list, and the version of this
   * test that read `panel.props.children` would have gone green on a screen
   * that had quietly dropped two of the lines.
   */
  it('says the assistant is told the labels, not only the sentence', async () => {
    await wrap(<ConsentScreen />);
    await screen.findByText(/to work out what you meant/);

    for (const category of [
      /calendar today and tomorrow/i,
      /timetable, with times and places/i,
      /open tasks and when they are due/i,
      /projects, notes, lists, habits, places, spending categories/i,
      /people you keep track of/i,
    ]) {
      expect(screen.getByText(category)).toBeTruthy();
    }
  });

  /**
   * And it must not promise something the recogniser does not deliver.
   *
   * "Never sent — the recording" was false whenever the phone had no offline
   * voice for the locale, which is the normal state on most Android devices and
   * on any iPhone whose locale dictation was never downloaded: the session
   * simply started with `requiresOnDeviceRecognition: false`. The screen now
   * says what happens in both cases, and what saying no does about it.
   */
  it('does not claim the audio can never leave the phone', async () => {
    await wrap(<ConsentScreen />);
    await screen.findByText('Goes to Google');

    expect(screen.queryByText(/audio is gone the moment/i)).toBeNull();
    expect(screen.getByText(/offline voice for your language/i)).toBeTruthy();
    // The refusal is what makes it true, so it has to be part of the answer.
    expect(screen.getByText(/Say no below and it never does/i)).toBeTruthy();
  });

  it.each([
    ['personal-key', /straight to Google/i],
    ['hosted', /Ridik's server/i],
    ['offline', /nothing is being sent today/i],
  ] as const)('tells a %p build how its own requests travel', async (mode, expected) => {
    mockMode = mode;
    await wrap(<ConsentScreen />);

    expect(await screen.findByText(expected)).toBeTruthy();
  });

  /* The counter has lived behind seven taps on the version row, which is to say
     it has been shown to nobody it was written for. The moment somebody decides
     whether requests may be sent is the moment their number matters. */
  it('shows the free trial on a build that has one', async () => {
    registerBillingProvider(billing(true));
    await wrap(<ConsentScreen />);

    expect(await screen.findByText(/25 of 25 free requests left/)).toBeTruthy();
  });

  it('says nothing about a trial on a build with nothing to sell', async () => {
    await wrap(<ConsentScreen />);
    await screen.findByText('Goes to Google');

    expect(screen.queryByText(/free requests left/)).toBeNull();
  });
});

describe('the decision', () => {
  it('records consent, the moment it was given, and the end of the first run', async () => {
    await wrap(<ConsentScreen />);

    await fireEvent.press(await screen.findByTestId('consent-allow'));

    await waitFor(() => expect(mockSetMany).toHaveBeenCalled());
    expect(mockSetMany).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantConsent: 'granted',
        onboardingComplete: true,
        assistantConsentAt: expect.any(Number),
      }),
    );
  });

  /* Declining is an answer, not an unanswered screen: it is written down, so
     nothing asks again — and it closes the first run just as completely. */
  it('records a refusal rather than leaving the question open', async () => {
    await wrap(<ConsentScreen />);

    await fireEvent.press(await screen.findByTestId('consent-decline'));

    await waitFor(() => expect(mockSetMany).toHaveBeenCalled());
    expect(mockSetMany).toHaveBeenCalledWith(
      expect.objectContaining({ assistantConsent: 'declined', onboardingComplete: true }),
    );
  });

  /* Revocable, from the same screen, with the same words in front of it. A
     switch in Settings could turn this back on without showing anybody what
     they were agreeing to, which is not agreement. */
  it('offers a way back off once it is on', async () => {
    mockStored = { ...defaultSettings(), assistantConsent: 'granted' };
    await wrap(<ConsentScreen />);

    // Waits for the settings read: `useSettings` reports the declared default
    // until it lands, and the screen would otherwise still be drawing the
    // first-run labels when the press went in.
    await screen.findByText(/You can stop this at any time/);
    const off = screen.getByTestId('consent-decline');
    expect(off.props.accessibilityLabel).toBe('Stop sending');
    await fireEvent.press(off);

    await waitFor(() => expect(mockSetMany).toHaveBeenCalled());
    expect(mockSetMany).toHaveBeenCalledWith(
      expect.objectContaining({ assistantConsent: 'declined' }),
    );
  });

  /* "Done" on an already-granted screen is a way out, not a second grant. */
  it('does not rewrite a decision that has not changed', async () => {
    mockStored = { ...defaultSettings(), assistantConsent: 'granted' };
    await wrap(<ConsentRoute />);

    await screen.findByText(/You can stop this at any time/);
    await fireEvent.press(screen.getByTestId('consent-allow'));

    expect(mockSetMany).not.toHaveBeenCalled();
    expect(mockRouterBack).toHaveBeenCalled();
  });
});

describe('the first-run lid', () => {
  it('covers the app until the question is answered', async () => {
    await wrap(<ConsentGate />);

    expect(await screen.findByTestId('consent-gate')).toBeTruthy();
    // The lid now opens on the welcome rather than straight onto the
    // disclosure; what has not changed is that only the disclosure lifts it.
    expect(screen.getByTestId('welcome-flow')).toBeTruthy();
  });

  /*
   * The one thing the flow must never be able to do.
   *
   * There is a single control on every step now — a Skip was tried and removed,
   * because a second button under the primary one is a choice on the one screen
   * whose job is to be followed. Walking the whole tour therefore lands on the
   * permission step, and the disclosure is still the last thing between it and
   * a usable app. If a route ever appears that reaches home without passing the
   * screen that names the third party your voice goes to, this fails.
   */
  it('has no way past the disclosure', async () => {
    mockLevel = 'granted';
    await wrap(<ConsentGate />);
    await screen.findByTestId('welcome-flow');

    for (let panel = 0; panel < 3; panel += 1) {
      await fireEvent.press(screen.getByText('Next'));
    }
    expect(screen.queryByTestId('consent-screen')).toBeNull();

    await fireEvent.press(screen.getByText('Continue'));
    expect(await screen.findByText('Goes to Google')).toBeTruthy();
  });

  /*
   * The app needs all three to do what it does, so the flow does not continue
   * without them. The locked button *names what is missing* rather than going
   * grey and silent — a disabled control with no explanation is the commonest
   * way an onboarding dead-ends, and here the explanation costs three words.
   *
   * The escape hatch this must never lose is in `AskRow`: a permission the OS
   * has hard-blocked raises no dialog again, so that row offers system settings
   * instead of a button that would do nothing. Requiring a permission you
   * cannot ask for twice is otherwise an install with no way forward.
   */
  it('will not continue until every permission is granted', async () => {
    mockLevel = 'denied';
    await wrap(<ConsentGate />);
    await screen.findByTestId('welcome-flow');
    for (let panel = 0; panel < 3; panel += 1) {
      await fireEvent.press(screen.getByText('Next'));
    }

    // Still says Continue — it is off, not renamed. The label became a sentence
    // for one build ("3 still needed", with a padlock) and read as a different
    // control appearing where the button had been.
    const locked = screen.getByText('Continue');
    await fireEvent.press(locked);
    expect(screen.queryByTestId('consent-screen')).toBeNull();

    // And a dim button says nothing to a screen reader, so the label does.
    expect(
      screen.getByLabelText(/Not yet available — Microphone, Notifications, Calendar/),
    ).toBeTruthy();
  });

  /** Blocked is not a dead end: it is the one state that sends you to the OS. */
  it('sends a blocked permission to system settings', async () => {
    mockLevel = 'blocked';
    await wrap(<ConsentGate />);
    await screen.findByTestId('welcome-flow');
    for (let panel = 0; panel < 3; panel += 1) {
      await fireEvent.press(screen.getByText('Next'));
    }

    expect(screen.getAllByText('Settings')).toHaveLength(3);
  });

  it.each(['granted', 'declined'] as const)('is gone once the answer is %p', async (answer) => {
    mockStored = { ...defaultSettings(), assistantConsent: answer };
    await wrap(<ConsentGate />);

    // Nothing to wait for — but the settings query resolves a tick later, and
    // a lid that appeared and then vanished would still have been a lid.
    await waitFor(() => expect(screen.queryByTestId('consent-gate')).toBeNull());
    expect(screen.queryByTestId('consent-gate')).toBeNull();
  });

  /* `useSetting` reports the declared default — `unset` — while the read is in
     flight, which is right for a switch and catastrophic here: it would put a
     full-screen consent sheet over the first frame of every launch on every
     install that had already answered. */
  it('draws nothing at all until the row has actually been read', async () => {
    mockStored = { ...defaultSettings(), assistantConsent: 'granted' };
    await wrap(<ConsentGate />);

    expect(screen.queryByTestId('consent-gate')).toBeNull();
  });
});
