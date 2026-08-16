/**
 * The engineering surface, and the two read-outs it exists to carry.
 *
 * Rendered through the real hooks with only the repositories and the native
 * services faked, exactly as the profile screen is: the query keys and the
 * render paths are the production ones.
 *
 * `reset-surfaces.test.ts` already reads this file's *source* for the two
 * things that must never appear on it — a control that lowers the trial
 * counter, and a route that renders without the developer switch. This suite is
 * the other half: what the screen must actually *say*, given numbers.
 */
import { render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { defaultSettings } from '@/repositories/settings';
import type { LatencySummary } from '@/repositories/llmInteractions';
import { LATENCY_TARGET_P95_MS } from '@/repositories/llmInteractions';
import { describeTrial } from '@/services/billing/allowance';
import { setEmberChoice } from '@/hooks/useEmber';
import { DEFAULT_EMBER } from '@/ui/theme';

import { ThemeProvider } from '../ThemeProvider';

let mockLatency: LatencySummary;

const mockRepos = {
  settings: { getAll: jest.fn(), set: jest.fn() },
  notes: { rebuildSearchIndex: jest.fn() },
  llmInteractions: { latency: jest.fn(async () => mockLatency) },
  db: {},
};

jest.mock('@/repositories', () => ({ getRepositories: () => mockRepos }));

/* The spend meter reads SQLite through `createUsageMeter`. The figures beside
   the latency are not what this suite is about, so the meter answers a fixed
   month rather than dragging the usage tables in. */
jest.mock('@/llm/usage', () => {
  const actual = jest.requireActual<typeof import('@/llm/usage')>('@/llm/usage');
  const window = {
    requests: 12,
    calls: 14,
    inputTokens: 1_000,
    outputTokens: 200,
    cachedTokens: 300,
    costMicros: 4_200,
  };
  return {
    ...actual,
    createUsageMeter: () => ({
      snapshot: async () => ({
        today: window,
        month: window,
        remainingToday: 188,
        remainingThisMonth: 2_988,
      }),
    }),
  };
});

/* Every native answer this screen renders, supplied here so the screen is what
   is under test. */
jest.mock('@/hooks/useSystem', () => ({
  useSecret: () => ({ data: { present: false, preview: null }, isLoading: false }),
  useSetSecret: () => ({ mutate: jest.fn(), isPending: false }),
  useCalendarConnection: () => ({
    data: { configured: false, connected: false },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useConnectCalendar: () => ({ mutate: jest.fn(), isPending: false }),
  useDisconnectCalendar: () => ({ mutate: jest.fn(), isPending: false }),
  useSyncCalendarNow: () => ({ mutate: jest.fn(), isPending: false }),
  usePermissions: () => ({ data: undefined, isLoading: false, isError: false, refetch: jest.fn() }),
  useRequestPermission: () => ({ mutate: jest.fn(), isPending: false }),
  useBackgroundStatus: () => ({ data: undefined }),
  useDatabaseStats: () => ({ data: undefined }),
  useLogEntries: () => [],
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
  Redirect: () => null,
  useFocusEffect: (effect: () => void | (() => void)) => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(effect, [effect]);
  },
}));

jest.mock('@/hooks/useAssistant', () => ({
  useAssistantMode: () => ({ data: 'personal-key', isLoading: false }),
}));

jest.mock('@/features/export', () => ({
  copyToClipboard: jest.fn(async () => ({ ok: true, value: undefined })),
}));

import DeveloperScreen from '../../../app/developer';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function latency(over: Partial<LatencySummary> = {}): LatencySummary {
  return {
    window: 100,
    turns: 40,
    timed: 40,
    medianMs: 900,
    p95Ms: 2_400,
    slowestMs: 2_400,
    withinTarget: true,
    ...over,
  };
}

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">
        <QueryClientProvider client={client}>
          <DeveloperScreen />
        </QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  setEmberChoice(DEFAULT_EMBER);
  mockLatency = latency();
  mockRepos.settings.getAll.mockResolvedValue({
    ...defaultSettings(),
    developerMode: true,
    llmTrialRequestsUsed: 18,
  });
  mockRepos.settings.set.mockImplementation(async (_key: string, value: unknown) => value);
  mockRepos.notes.rebuildSearchIndex.mockResolvedValue(0);
});

describe('developer screen', () => {
  /*
   * The whole point of the change: `latency_ms` was written on every turn and
   * read by nothing, so the app measured how slow it was and threw the
   * measurement away. Both figures, because neither alone is honest — the
   * median is what a turn usually costs and the 95th is what gets complained
   * about.
   */
  it('reads the latency it has been recording all along', async () => {
    await wrap();

    expect(await screen.findByText('Reply time')).toBeTruthy();
    expect(screen.getByText('900 ms typical · 95% under 2.4 s')).toBeTruthy();
    // The window it is measured over, so nobody reads a young install's four
    // turns as a verdict.
    expect(screen.getByText(/Over the last 40 timed turns/)).toBeTruthy();
  });

  /* A number with nothing to compare it against cannot say whether the
     assistant got worse, which is the only reason to put it here. */
  it('says when the slow tail is past the target, and names the worst turn', async () => {
    mockLatency = latency({
      medianMs: 1_200,
      p95Ms: LATENCY_TARGET_P95_MS + 2_000,
      slowestMs: 11_000,
      withinTarget: false,
    });
    await wrap();

    expect(await screen.findByText(/95% under 6.0 s/)).toBeTruthy();
    expect(screen.getByText(/past the 4.0 s it is held to/)).toBeTruthy();
    expect(screen.getByText(/the worst was 11.0 s/)).toBeTruthy();
  });

  /* An instrument with nothing to measure says nothing. "—" would read as a
     zero, which is a claim nobody made. */
  it('draws no read-out at all until a turn has been timed', async () => {
    mockLatency = latency({ turns: 0, timed: 0, medianMs: null, p95Ms: null, slowestMs: null, withinTarget: null });
    await wrap();

    await screen.findByText('Mode');
    expect(screen.queryByText('Reply time')).toBeNull();
  });

  /* Moved here, not deleted: the trial read-out is the developer's copy of what
     the profile now says in its own words, and it must stay read-only. */
  it('still shows the trial as a read-out', async () => {
    await wrap();

    // The value, not the label: the label is static and the row renders before
    // the settings read lands on it.
    expect(
      await screen.findByText(describeTrial({ requestsUsed: 18, tokensUsed: 0 })),
    ).toBeTruthy();
    expect(screen.getByText('Free trial')).toBeTruthy();
  });
});
