import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { currentZone, epochToLocal, todayLocalDate } from '@/core/time';
import type { Transaction } from '@/db/schema';
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
    distinctCategories: jest.fn(),
    addTransaction: jest.fn(),
  },
  crm: {
    listEntities: jest.fn(),
  },
  settings: {
    getAll: jest.fn(),
  },
  habits: {
    listHabits: jest.fn(),
    habitHistory: jest.fn(),
  },
  activity: {
    summarise: jest.fn(),
    log: jest.fn(),
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

function transaction(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    amount: 12.5,
    currency: 'EUR',
    category: 'filament',
    entityName: null,
    description: 'Spool of PLA',
    createdAt: Date.now(),
    direction: 'expense',
    projectId: null,
    localDate: TODAY,
    ...over,
  };
}

/** A period the ledger will render rows for, holding exactly `transaction()`. */
function oneTransactionPeriod(): LedgerQueryResult {
  return emptyLedger({
    count: 1,
    from: Date.now() - 86_400_000,
    to: Date.now() + 1,
    primaryCurrency: 'EUR',
    expenseByCurrency: { EUR: 12.5 },
    netByCurrency: { EUR: -12.5 },
  });
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
  mockRepos.ledger.distinctCategories.mockResolvedValue([]);
  mockRepos.ledger.addTransaction.mockResolvedValue(transaction());
  mockRepos.crm.listEntities.mockResolvedValue([]);
  mockRepos.settings.getAll.mockResolvedValue({ primaryCurrency: 'EUR' });
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

  /* Both fields are join keys: the category is what the breakdown groups on and
     the entity name is the only link to a person's Money section. Typed freely,
     one slip forks the chart or detaches the row, and nothing merges them back
     — so the sheet offers the spellings that already exist. */
  it('picks the category and the person from what already exists', async () => {
    mockRepos.ledger.query.mockResolvedValue(oneTransactionPeriod());
    mockRepos.ledger.listRecent.mockResolvedValue([transaction()]);
    mockRepos.ledger.distinctCategories.mockResolvedValue(['filament', 'coffee']);
    mockRepos.crm.listEntities.mockResolvedValue([
      {
        entity: { id: 'e1', name: 'Ivo Petrov' },
        aliases: [],
        openCommitments: 0,
        interactionCount: 0,
        lastInteractionAt: null,
      },
    ]);

    await wrap(<LedgerScreen />);
    await fireEvent.press(await screen.findByLabelText('Spool of PLA, spent €12.50'));

    expect(await screen.findByLabelText('coffee')).toBeTruthy();
    expect(screen.getByLabelText('filament').props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(screen.getByLabelText('Ivo Petrov')).toBeTruthy();
    // No entity on this row, and "None" says so rather than an empty box.
    expect(screen.getByLabelText('None').props.accessibilityState).toMatchObject({
      selected: true,
    });
  });

  it('deletes from inside the edit sheet, never from the row that opens it', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockRepos.ledger.query.mockResolvedValue(oneTransactionPeriod());
    mockRepos.ledger.listRecent.mockResolvedValue([transaction()]);

    await wrap(<LedgerScreen />);
    const row = await screen.findByLabelText('Spool of PLA, spent €12.50');

    expect(row.props.accessibilityHint).toBe('Tap to edit');
    await fireEvent(row, 'longPress');
    expect(alert).not.toHaveBeenCalled();

    await fireEvent.press(row);
    await fireEvent.press(await screen.findByLabelText('Delete'));
    expect(alert.mock.calls[0]?.[0]).toBe('Delete this transaction?');
  });

  /* The voice executor was the only writer of a transaction, so an install
     without an LLM key had a Money screen it could read and never add to,
     coaching a sentence that nothing was listening for. */
  it('opens a compose sheet from the header without a word being spoken', async () => {
    mockRepos.ledger.distinctCategories.mockResolvedValue(['filament']);

    await wrap(<LedgerScreen />);
    expect(screen.queryByText('New transaction')).toBeNull();

    await fireEvent.press(await screen.findByLabelText('Add'));

    expect(screen.getByText('New transaction')).toBeTruthy();
    // The same fields as the edit sheet, offering the same spellings, so a
    // typed row and a spoken one group together instead of forking the chart.
    expect(await screen.findByLabelText('filament')).toBeTruthy();
    expect(screen.getByText('PERSON OR PLACE')).toBeTruthy();
    expect(screen.getByText('WHEN')).toBeTruthy();
  });

  it('adds what was typed, in the currency the settings name', async () => {
    // Not EUR: the amount carries whatever the setting says, and nothing on the
    // sheet offers a second place to get that wrong.
    mockRepos.settings.getAll.mockResolvedValue({ primaryCurrency: 'BGN' });
    mockRepos.ledger.distinctCategories.mockResolvedValue(['filament']);

    await wrap(<LedgerScreen />);
    await fireEvent.press(await screen.findByLabelText('Add'));

    expect(await screen.findByText('AMOUNT (BGN)')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('transaction-amount'), '12,50');
    await fireEvent.changeText(screen.getByTestId('transaction-description'), 'Spool of PLA');
    await fireEvent.press(screen.getByLabelText('filament'));
    await fireEvent.press(screen.getByText('Income'));
    await fireEvent.press(screen.getByLabelText('Yesterday'));
    await fireEvent.press(screen.getByLabelText('Add transaction'));

    await waitFor(() => expect(mockRepos.ledger.addTransaction).toHaveBeenCalled());
    const input = mockRepos.ledger.addTransaction.mock.calls[0][0];
    expect(input).toMatchObject({
      // A comma is what a European keyboard offers first.
      amount: 12.5,
      currency: 'BGN',
      category: 'filament',
      description: 'Spool of PLA',
      direction: 'income',
    });
    // The day is a named choice, never a typed date: it can only ever land on
    // the day it says.
    expect(epochToLocal(input.at, ZONE).toISODate()).toBe(YESTERDAY);
    // The sheet closes on the write, not before it.
    await waitFor(() => expect(screen.queryByText('New transaction')).toBeNull());
  });

  it('refuses an amount that is not a number rather than writing a zero', async () => {
    mockRepos.ledger.distinctCategories.mockResolvedValue(['filament']);

    await wrap(<LedgerScreen />);
    await fireEvent.press(await screen.findByLabelText('Add'));
    await fireEvent.changeText(screen.getByTestId('transaction-amount'), 'twelve');
    await fireEvent.press(await screen.findByLabelText('filament'));
    await fireEvent.press(screen.getByLabelText('Add transaction'));

    expect(mockRepos.ledger.addTransaction).not.toHaveBeenCalled();
    // Still open, over everything that was typed: a rejected save that also
    // threw the entry away would be worse than the bad amount.
    expect(screen.getByText('New transaction')).toBeTruthy();
    expect(screen.getByTestId('transaction-amount').props.value).toBe('twelve');
  });

  it('refuses a transaction with no category, which is what the breakdown groups on', async () => {
    mockRepos.ledger.distinctCategories.mockResolvedValue(['filament']);

    await wrap(<LedgerScreen />);
    await fireEvent.press(await screen.findByLabelText('Add'));
    await fireEvent.changeText(screen.getByTestId('transaction-amount'), '12.50');
    // Offered and left alone: nothing is picked for the user.
    expect(await screen.findByLabelText('filament')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Add transaction'));

    expect(mockRepos.ledger.addTransaction).not.toHaveBeenCalled();
    expect(screen.getByText('New transaction')).toBeTruthy();
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

  /* Nothing reads a habit's unit — the grid counts days either way — so the
     new-habit form asks for the name and nothing else. */
  it('asks only for a name when a habit is added', async () => {
    await wrap(<HabitsScreen />);
    await fireEvent.press(await screen.findByLabelText('Add a habit'));

    expect(screen.getByText('NEW HABIT')).toBeTruthy();
    expect(screen.queryByText('UNIT')).toBeNull();
    expect(screen.queryByText('Minutes')).toBeNull();
  });

  /* The card itself logs the day, so a long press is one slip away from every
     tap — nothing behind it may destroy the streak. */
  it('offers archive and nothing destructive on a long press', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockRepos.habits.listHabits.mockResolvedValue([
      habitRow({ name: 'Anki', lastCompletedDate: TODAY, streak: 4 }),
    ]);

    await wrap(<HabitsScreen />);
    await fireEvent(await screen.findByText('Anki'), 'longPress');

    const buttons = alert.mock.calls[0]?.[2] ?? [];
    expect(buttons.map((button) => button.text)).toEqual(['Cancel', 'Archive']);
  });
});

describe('activity screen', () => {
  const ENTRY = {
    id: 'e1',
    habitId: null,
    description: 'Rewrote the pump firmware',
    durationMinutes: 90,
    loggedAt: Date.now(),
    projectId: 'p1',
    localDate: TODAY,
    source: 'voice',
  };

  function withOneEntry() {
    mockRepos.activity.summarise.mockResolvedValue(
      emptySummary({
        entries: [ENTRY],
        totalMinutes: 90,
        byDay: [{ date: TODAY, entries: [ENTRY], minutes: 90 }],
        byProject: [{ id: 'p1', name: 'Pump', count: 1, minutes: 90 }],
      }),
    );
  }

  /** Opens the header's log sheet on an otherwise empty period. */
  async function openLogSheet() {
    await wrap(<ActivityScreen />);
    await fireEvent.press(await screen.findByLabelText('Add'));
  }

  it('summarises the period and offers the export once there is something to export', async () => {
    withOneEntry();

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

  /* One markdown document, two ways out. Mail and PDF are what the OS share
     sheet does with the file, not rows this app has to own. */
  it('hands the export to the clipboard or the share sheet and nowhere else', async () => {
    withOneEntry();

    await wrap(<ActivityScreen />);
    await fireEvent.press(await screen.findByLabelText('Export'));

    expect(await screen.findByLabelText('Copy markdown')).toBeTruthy();
    expect(screen.getByLabelText('Share file')).toBeTruthy();
    expect(screen.queryByLabelText('Export PDF')).toBeNull();
    expect(screen.queryByLabelText('Email')).toBeNull();
  });

  /* `activity_log` is the only activity tool in the LLM contract: voice writes
     the log and nothing removes from it. Until an `activity_delete` exists,
     this row is the one route out of a mis-logged entry, so it keeps both the
     gesture and the accessibility action that reaches it without one. */
  it('deletes a mis-logged entry from the row, by gesture or by screen reader', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    withOneEntry();

    await wrap(<ActivityScreen />);
    const row = await screen.findByLabelText('Rewrote the pump firmware');

    expect(row.props.accessibilityActions).toEqual([
      { name: 'longpress', label: 'Delete entry' },
    ]);

    await fireEvent(row, 'longPress');
    expect(alert.mock.calls[0]?.[0]).toBe('Delete this entry?');

    alert.mockClear();
    await fireEvent(row, 'accessibilityAction', {
      nativeEvent: { actionName: 'longpress' },
    });
    expect(alert.mock.calls[0]?.[0]).toBe('Delete this entry?');
  });

  /* Two fields and no more. `ActivityLogInput` also takes a habit name and a
     project id: a typed habit name creates a second habit instead of failing,
     and a project id is not something anyone can type. */
  it('asks for a description and a duration when an entry is added', async () => {
    await openLogSheet();

    expect(screen.getByText('Log an entry')).toBeTruthy();
    expect(screen.getByTestId('activity-description')).toBeTruthy();
    expect(screen.getByTestId('activity-minutes')).toBeTruthy();
    expect(screen.queryByText('HABIT')).toBeNull();
    expect(screen.queryByText('PROJECT')).toBeNull();
  });

  it('logs what was typed, with the duration in minutes', async () => {
    mockRepos.activity.log.mockResolvedValue(ENTRY);

    await openLogSheet();
    await fireEvent.changeText(screen.getByTestId('activity-description'), 'Soldered the board');
    await fireEvent.changeText(screen.getByTestId('activity-minutes'), '45');
    await fireEvent.press(screen.getByLabelText('Log entry'));

    await waitFor(() =>
      expect(mockRepos.activity.log).toHaveBeenCalledWith({
        description: 'Soldered the board',
        durationMinutes: 45,
        // The feed defaults to 'voice' because that was the only way in for
        // most of this app's life. This one was typed and has to say so.
        source: 'manual',
      }),
    );
  });

  /* The repository refuses a blank description by throwing, which would reach
     the user as a failed write of something they never asked to write. */
  it('refuses an entry with no description', async () => {
    await openLogSheet();
    await fireEvent.changeText(screen.getByTestId('activity-minutes'), '45');

    const submit = screen.getByLabelText('Log entry');
    expect(submit.props.accessibilityState).toMatchObject({ disabled: true });

    await fireEvent.press(submit);
    expect(mockRepos.activity.log).not.toHaveBeenCalled();
  });
});
