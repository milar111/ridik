/**
 * The `/unlock` route — where a web purchase comes home.
 *
 * `webFunnel.ts` decides what happened; this proves the user is told, and that
 * is a separate suite because the whole bug class lives in the wiring rather
 * than the logic.
 *
 * The first version of this was a `Linking` listener in the root layout. It
 * worked in every unit test and failed on a device in two ways at once: on a
 * cold start the launch screen was expo-router's "Unmatched Route" for as long
 * as the app took to boot, and navigating off that page tore the layout subtree
 * down — so the toast announcing the verdict was raised into a `ToastProvider`
 * that was already being discarded, and a refused link told the user nothing.
 * A file route has neither problem, which is why the app's existing convention
 * turned out to be the right one. These tests hold that shape in place.
 */
import { render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { ThemeProvider } from '../ThemeProvider';
import { ToastProvider } from '../components/Toast';

/** The toast sits under the status bar, so it needs insets to lay out at all. */
const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const mockReplace = jest.fn();
const mockRedeem = jest.fn();
let mockParams: Record<string, string | string[] | undefined> = {};

jest.mock('expo-router', () => ({
  __esModule: true,
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => mockParams,
}));

jest.mock('@/services/billing/webFunnel', () => {
  const actual = jest.requireActual('@/services/billing/webFunnel');
  return {
    __esModule: true,
    ...actual,
    redeemUnlockLink: (url: string) => mockRedeem(url),
  };
});

// Imported after the mocks so the screen under test sees them.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const UnlockScreen = require('../../../app/unlock').default;

const SESSION = 'cs_live_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5';

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function mount() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">
        <QueryClientProvider client={client}>
          <ToastProvider>
            <UnlockScreen />
          </ToastProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  mockReplace.mockReset();
  mockRedeem.mockReset();
  mockRedeem.mockResolvedValue({ status: 'unconfigured' });
  mockParams = { session: SESSION };
});

describe('the /unlock route', () => {
  it('hands the session to the funnel as a link, so one parser owns what is valid', async () => {
    await mount();
    await waitFor(() => expect(mockRedeem).toHaveBeenCalled());
    expect(mockRedeem).toHaveBeenCalledWith(`ridik:///unlock?session=${SESSION}`);
  });

  it("accepts Stripe's own parameter name", async () => {
    mockParams = { session_id: SESSION };
    await mount();
    await waitFor(() =>
      expect(mockRedeem).toHaveBeenCalledWith(`ridik:///unlock?session_id=${SESSION}`),
    );
  });

  it('forwards a repeated parameter intact rather than picking a winner', async () => {
    // Two different sessions in one link is the parser's call to refuse. A
    // screen that quietly dropped one would make that check unreachable.
    mockParams = { session: [SESSION, 'cs_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] };
    await mount();
    await waitFor(() =>
      expect(mockRedeem).toHaveBeenCalledWith(
        `ridik:///unlock?session=${SESSION}&session=cs_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
      ),
    );
  });

  it('still asks when the link carried nothing, so the refusal is the funnel’s', async () => {
    mockParams = {};
    await mount();
    await waitFor(() => expect(mockRedeem).toHaveBeenCalledWith('ridik:///unlock'));
  });

  it('says so out loud when a link is refused', async () => {
    mockRedeem.mockResolvedValue({
      status: 'rejected',
      reason: 'already-redeemed',
      message: 'That link has already been used. Try Restore purchases.',
    });
    await mount();

    await waitFor(() =>
      expect(
        screen.getByText('That link has already been used. Try Restore purchases.'),
      ).toBeTruthy(),
    );
  });

  it('announces a successful unlock', async () => {
    mockRedeem.mockResolvedValue({ status: 'unlocked', entitlement: { active: true } });
    await mount();
    await waitFor(() => expect(screen.getByText('Subscription unlocked')).toBeTruthy());
  });

  it('passes a still-settling payment through as its own message', async () => {
    mockRedeem.mockResolvedValue({ status: 'pending', message: 'Payment received.' });
    await mount();
    await waitFor(() => expect(screen.getByText('Payment received.')).toBeTruthy());
  });

  it('is silent when the build has no backend', async () => {
    await mount();
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());

    // Every toast draws a Dismiss control, so its absence is the absence of a
    // toast: an unconfigured build says nothing and unlocks nothing, exactly as
    // the app behaved before the funnel existed.
    expect(screen.queryByLabelText('Dismiss')).toBeNull();
  });

  it('never stays here — there is nothing on this screen to come back to', async () => {
    mockRedeem.mockResolvedValue({ status: 'rejected', reason: 'expired', message: 'Expired.' });
    await mount();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
  });

  it('holds a spinner while it waits rather than flashing an empty page', async () => {
    mockRedeem.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(screen.getByLabelText('Confirming your purchase')).toBeTruthy();
  });

  it('redeems once even if something above it re-renders', async () => {
    const { rerender } = await mount();
    await waitFor(() => expect(mockRedeem).toHaveBeenCalledTimes(1));

    // `useLocalSearchParams` hands back a fresh object every render; keying the
    // redemption on it would restart the exchange on any parent re-render.
    await rerender(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider forceScheme="dark">
          <QueryClientProvider client={client}>
            <ToastProvider>
              <UnlockScreen />
            </ToastProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>,
    );

    expect(mockRedeem).toHaveBeenCalledTimes(1);
  });
});
