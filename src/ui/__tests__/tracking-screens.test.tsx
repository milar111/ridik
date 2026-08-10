import { render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { currentZone, epochToLocal, todayLocalDate } from '@/core/time';
import type { ActivitySummary } from '@/repositories/activity';
import type { LedgerQueryResult } from '@/repositories/ledger';

import { ThemeProvider } from '../ThemeProvider';

/* The screens read through the real hooks, so only the repository layer under
   them is faked — the query keys, the enabled flags and the render paths are
   all the production ones. */
const mockRepos = {
  ledger: {
    query: jest.fn(),
    listRecent: jest.fn(),
    monthlyTotals: jest.fn(),
  },
  habits: {
    listHabits: jest.fn(),
    habitHistory: jest.fn(),
  },
  activity: {
    summarise: jest.fn(),
  },
};

jest.mock('@/repositories', () => ({ getRepositories: () => mockRepos }));

/* Reanimated 4 boots its worklets runtime on import and has no native side
   here; the toast stack (pulled in by the component barrel) is the only thing
   in these trees that touches it. */
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  const modifier = { duration: () => modifier };
  return {
    __esModule: true,
    default: {
      View: ({ entering, exiting, layout, ...rest }: Record<string, unknown>) =>
        React.createElement(View, rest),
    },
    FadeInUp: modifier,
    FadeOutUp: modifier,
    LinearTransition: modifier,
  };
});

import ActivityScreen from '../../../app/activity';
import HabitsScreen from '../../../app/habits';
import LedgerScreen from '../../../app/ledger';

const ZONE = currentZone();
const TODAY = todayLocalDate(ZONE);
const YESTERDAY = epochToLocal(Date.now(), ZONE).minus({ days: 1 }).toISODate()!;

function emptyLedger(overrides: Partial<LedgerQueryResult> = {}): LedgerQueryResult {
  return {
    total: 0,
    count: 0,
    from: null,
    to: null,
    primaryCurrency: null,
    totalsByCurrency: {},
    expenseByCurrency: {},
    incomeByCurrency: {},
    netByCurrency: {},
    groups: [],
    ...overrides,
  };
}

function emptySummary(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
  return { entries: [], totalMinutes: 0, byDay: [], byProject: [], byHabit: [], ...overrides };
}

function habitRow(over: { name: string; lastCompletedDate: string | null; streak: number }) {
  return {
    id: over.name.toLowerCase(),
    name: over.name,
    currentStreak: over.streak,
    lastCompletedDate: over.lastCompletedDate,
    longestStreak: over.streak,
    targetPerWeek: null,
    unit: 'session' as const,
    color: null,
    isArchived: false,
    createdAt: 0,
  };
}

/** Without seeded metrics the provider withholds its children until layout. */
const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

// RNTL 14 renders asynchronously; every render/unmount must be awaited.
function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">
        <QueryClientProvider client={client}>{ui}</QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  mockRepos.ledger.query.mockResolvedValue(emptyLedger());
  mockRepos.ledger.listRecent.mockResolvedValue([]);
  mockRepos.ledger.monthlyTotals.mockResolvedValue([]);
  mockRepos.habits.listHabits.mockResolvedValue([]);
  mockRepos.habits.habitHistory.mockResolvedValue([]);
  mockRepos.activity.summarise.mockResolvedValue(emptySummary());
});

describe('ledger screen', () => {
  it('coaches the user with a spoken example when the period is empty', async () => {
    await wrap(<LedgerScreen />);
    expect(await screen.findByText("Try: 'spent 12 euros on 3D printer filament'")).toBeTruthy();
  });

  it('reports every currency separately instead of one merged total', async () => {
    const from = Date.now() - 86_400_000;
    mockRepos.ledger.query.mockResolvedValue(
      emptyLedger({
        count: 2,
        from,
        to: Date.now() + 1,
        primaryCurrency: 'EUR',
        expenseByCurrency: { EUR: 12.5, USD: 40 },
        incomeByCurrency: {},
        netByCurrency: { EUR: -12.5, USD: -40 },
        groups: [
          {
            key: 'filament',
            total: -12.5,
            count: 1,
            totalsByCurrency: { EUR: -12.5 },
            expenseByCurrency: { EUR: 12.5 },
            incomeByCurrency: {},
          },
        ],
      }),
    );

    await wrap(<LedgerScreen />);

    // Two total cards, never one merged number.
    expect(await screen.findAllByText('€12.50')).not.toHaveLength(0);
    expect(screen.getByText('$40.00')).toBeTruthy();
    // The breakdown belongs to the primary currency and says so.
    expect(screen.getByText('WHERE IT WENT · EUR')).toBeTruthy();
    expect(screen.getByText('filament')).toBeTruthy();
    // Recent rows are windowed; the count says how much of the period is shown.
    expect(screen.getByText('latest 0 of 2')).toBeTruthy();
  });
});

describe('habits screen', () => {
  it('floats an at-risk streak above the rest', async () => {
    mockRepos.habits.listHabits.mockResolvedValue([
      habitRow({ name: 'Anki', lastCompletedDate: TODAY, streak: 4 }),
      habitRow({ name: 'Workout', lastCompletedDate: YESTERDAY, streak: 9 }),
    ]);

    await wrap(<HabitsScreen />);

    expect(await screen.findByText('AT RISK')).toBeTruthy();
    const names = screen.getAllByText(/^(Anki|Workout)$/).map((node) => node.props.children);
    expect(names).toEqual(['Workout', 'Anki']);
  });

  it('teaches the voice phrasing when nothing is tracked', async () => {
    await wrap(<HabitsScreen />);
    expect(await screen.findByText("Try: 'logged 45 minutes of workout'")).toBeTruthy();
  });
});

describe('activity screen', () => {
  it('summarises the period and offers the export once there is something to export', async () => {
    const entry = {
      id: 'e1',
      habitId: null,
      description: 'Rewrote the pump firmware',
      durationMinutes: 90,
      loggedAt: Date.now(),
      projectId: 'p1',
      localDate: TODAY,
      source: 'voice',
    };
    mockRepos.activity.summarise.mockResolvedValue(
      emptySummary({
        entries: [entry],
        totalMinutes: 90,
        byDay: [{ date: TODAY, entries: [entry], minutes: 90 }],
        byProject: [{ id: 'p1', name: 'Pump', count: 1, minutes: 90 }],
      }),
    );

    await wrap(<ActivityScreen />);

    expect(await screen.findByText('Rewrote the pump firmware')).toBeTruthy();
    expect(screen.getAllByText('1h 30m')).not.toHaveLength(0);
    expect(screen.getAllByText('Pump')).not.toHaveLength(0);
    expect(screen.getByLabelText('Export').props.accessibilityState).toMatchObject({
      disabled: false,
    });
  });

  it('cannot export an empty period', async () => {
    await wrap(<ActivityScreen />);
    const button = await screen.findByLabelText('Export');
    expect(button.props.accessibilityState).toMatchObject({ disabled: true });
  });
});
