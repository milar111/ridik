/**
 * The one screen nobody may skip, for the people most likely to skip it.
 *
 * `ConsentGate` is drawn as an overlay over a navigator that stays mounted and
 * live underneath — deliberately, because gating the navigator is what leaves a
 * cold start on "Unmatched Route". It claims touches, so a finger cannot reach
 * the microphone under the lid. A screen reader is not a finger: it walks the
 * view tree, and every control below was still one swipe away. That made the
 * gate skippable by exactly the users who could not see that they had skipped
 * it, on the screen that names the third party their voice goes to.
 *
 * iOS is answered here, by `accessibilityViewIsModal` on the lid. Android has
 * no such prop and the answer there is `ConsentShield` in `app/_layout.tsx`,
 * which hides the tree underneath — this file asserts the hook that decides it,
 * because the layout itself cannot be rendered without a router.
 *
 * The other half is the decision. "Allow" spoken on its own is an answer with
 * the question missing, and it is the one decision in this app that no receipt
 * can take back.
 */
import { render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { Text } from 'react-native';

import { defaultSettings, type SettingsValues } from '@/repositories/settings';
import { ThemeProvider } from '../ThemeProvider';
import { ToastProvider } from '../components/Toast';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

let mockStored: SettingsValues;
let mockLoading = false;

jest.mock('@/hooks/useSettings', () => ({
  useSetting: (key: string) => ({
    value: (mockStored as unknown as Record<string, unknown>)[key],
    isLoading: mockLoading,
    error: null,
    set: jest.fn(),
  }),
  useSettings: () => ({ data: mockStored, isLoading: false }),
  useSetSettings: () => ({ mutate: jest.fn() }),
}));

jest.mock('@/hooks/useAssistant', () => ({
  useAssistantMode: () => ({ data: 'personal-key', isLoading: false }),
}));

jest.mock('@/hooks/useBilling', () => ({
  useEntitlement: () => ({ data: undefined, isLoading: true }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
}));

import { ConsentGate, ConsentScreen, useConsentGateOpen } from '@/features/consent';

function wrap(ui: React.ReactElement) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">
        <ToastProvider>{ui}</ToastProvider>
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  mockStored = defaultSettings();
  mockLoading = false;
});

describe('the first-run lid is a lid for a screen reader too', () => {
  it('stops VoiceOver walking into the app underneath it', async () => {
    await wrap(<ConsentGate />);

    expect(screen.getByTestId('consent-gate').props.accessibilityViewIsModal).toBe(true);
  });

  /* The Android half is a wrapper in `app/_layout.tsx` driven by this hook, so
     what it answers — and that it is silent while the row is still being read —
     is the contract worth pinning. */
  it('tells the layout when to hide everything below', async () => {
    function Probe() {
      return <Text>{useConsentGateOpen() ? 'open' : 'shut'}</Text>;
    }

    await wrap(<Probe />);
    expect(screen.getByText('open')).toBeTruthy();

    mockStored = { ...defaultSettings(), assistantConsent: 'granted' };
    await wrap(<Probe />);
    expect(screen.getAllByText('shut').length).toBeGreaterThan(0);
  });

  it('is not open merely because the answer has not been read yet', async () => {
    mockLoading = true;
    function Probe() {
      return <Text>{useConsentGateOpen() ? 'open' : 'shut'}</Text>;
    }

    await wrap(<Probe />);
    expect(screen.getByText('shut')).toBeTruthy();
  });
});

describe('the decision says what it decides', () => {
  it('names what Allow allows, rather than leaving the word alone', async () => {
    await wrap(<ConsentScreen />);

    const allow = screen.getByTestId('consent-allow');
    expect(allow.props.accessibilityLabel).toBe('Allow');
    expect(allow.props.accessibilityHint).toMatch(/Google/);
  });

  it('says what the offline answer costs and does not', async () => {
    await wrap(<ConsentScreen />);

    const decline = screen.getByTestId('consent-decline');
    expect(decline.props.accessibilityLabel).toBe('Use Ridik offline');
    expect(decline.props.accessibilityHint).toMatch(/Nothing is sent/);
  });

  /* The longest screen in the app, and the one nobody may skip. Headings are
     how a screen reader moves through it without swiping every paragraph. */
  it('marks its headings as headings', async () => {
    await wrap(<ConsentScreen />);

    expect(screen.getByText('Where your words go').props.accessibilityRole).toBe('header');
    expect(screen.getByText('Goes to Google').props.accessibilityRole).toBe('header');
  });
});
