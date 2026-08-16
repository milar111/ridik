/**
 * The screen that shows what was heard, what was done and what went wrong.
 *
 * Rendered through the *real* hooks with only `@/repositories` faked, the same
 * way the tracking screens are tested: the query keys, the enabled flags and
 * every render path are the production ones, and what is stubbed is the SQLite
 * underneath them.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { Interaction, InteractionStats } from '@/repositories/llmInteractions';

import { ThemeProvider } from '../ThemeProvider';

const mockRepos = {
  llmInteractions: {
    listRecent: jest.fn(),
    getById: jest.fn(),
    stats: jest.fn(),
    remove: jest.fn(),
    clear: jest.fn(),
  },
};

jest.mock('@/repositories', () => ({ getRepositories: () => mockRepos }));

const mockCopy = jest.fn();
jest.mock('@/features/export', () => ({
  copyToClipboard: (text: string) => {
    mockCopy(text);
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

import HistoryScreen, { formatLatency, formatParameter, groupByDay } from '../../../app/history';

const AT = Date.parse('2026-08-16T09:30:00Z');

function turn(over: Partial<Interaction> = {}): Interaction {
  return {
    id: 't1',
    transcript: 'add M4 bolts to the hardware list',
    confidence: null,
    rawResponse: null,
    actions: null,
    feedback: 'Added it.',
    status: 'ok',
    error: null,
    latencyMs: 940,
    model: 'gemini-2.5-flash',
    createdAt: AT,
    parsedActions: [],
    ...over,
  };
}

function stats(over: Partial<InteractionStats> = {}): InteractionStats {
  return {
    total: 1,
    ok: 1,
    clarify: 0,
    errors: 0,
    timed: 1,
    medianLatencyMs: 940,
    p95LatencyMs: 2100,
    actionsPerTurn: 1,
    models: [{ model: 'gemini-2.5-flash', turns: 1 }],
    oldestAt: AT,
    newestAt: AT,
    ...over,
  };
}

/** Without seeded metrics the provider withholds its children until layout. */
const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

// RNTL 14 renders asynchronously; every render and press must be awaited.
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
  mockRepos.llmInteractions.listRecent.mockResolvedValue([]);
  mockRepos.llmInteractions.stats.mockResolvedValue(stats({ total: 0, ok: 0, actionsPerTurn: null }));
  mockRepos.llmInteractions.remove.mockResolvedValue(true);
  mockRepos.llmInteractions.clear.mockResolvedValue(0);
  mockCopy.mockClear();
});

describe('history screen', () => {
  /* A privacy-minded person opens this screen before there is anything in it.
     "Nothing here" is not an answer — the screen has to say what it will hold
     and where it will be kept. */
  it('says what it will hold on a fresh install', async () => {
    await wrap(<HistoryScreen />);

    expect(await screen.findByText('Nothing has been said yet')).toBeTruthy();
    expect(
      screen.getByText(/keeps the exact words it heard, the changes it made and anything that failed/),
    ).toBeTruthy();
    // Nothing to delete, so nothing offers to.
    expect(screen.queryByLabelText('Delete all history')).toBeNull();
  });

  it('shows what was heard, with the model and how long it took', async () => {
    mockRepos.llmInteractions.listRecent.mockResolvedValue([turn()]);
    mockRepos.llmInteractions.stats.mockResolvedValue(stats());

    await wrap(<HistoryScreen />);

    expect(await screen.findByText('add M4 bolts to the hardware list')).toBeTruthy();
    // `latencyMs` is written on every turn and had no reader anywhere.
    expect(screen.getByText('· 940 ms')).toBeTruthy();
    expect(screen.getByText('· gemini-2.5-flash')).toBeTruthy();
    // And the header states the relationship rather than leaving two bare
    // numbers side by side for the reader to guess between.
    expect(screen.getByText('TYPICAL REPLY')).toBeTruthy();
    expect(screen.getByText('1 action per turn · 95% under 2.1 s · gemini-2.5-flash')).toBeTruthy();
  });

  /* The summary of an action is Ridik's interpretation; the parameters are what
     it actually did. "Added 1 item" reads the same whichever list it went to,
     and a mis-heard list name shows up nowhere else in the app. */
  it('expands a row to the raw transcript and the parameters each tool was given', async () => {
    mockRepos.llmInteractions.listRecent.mockResolvedValue([
      turn({
        parsedActions: [
          {
            toolName: 'checklist_add',
            parameters: { list_name: 'Hardware', items: ['M4 bolts'] },
            ok: true,
            summary: 'Added 1 item to Hardware',
            error: null,
            asked: null,
          },
        ],
      }),
    ]);
    mockRepos.llmInteractions.stats.mockResolvedValue(stats());

    await wrap(<HistoryScreen />);
    const row = await screen.findByLabelText('add M4 bolts to the hardware list, done');
    expect(row.props.accessibilityHint).toBe('Tap for the full transcript');
    expect(screen.queryByText('checklist_add')).toBeNull();

    await fireEvent.press(row);

    expect(screen.getByText('HEARD')).toBeTruthy();
    expect(screen.getByText('checklist_add')).toBeTruthy();
    expect(screen.getByText('list_name')).toBeTruthy();
    expect(screen.getByText('Hardware')).toBeTruthy();
    expect(screen.getByText('["M4 bolts"]')).toBeTruthy();
    expect(screen.getByText('Added it.')).toBeTruthy();
  });

  it('says what failed, and that nothing was written when it did', async () => {
    mockRepos.llmInteractions.listRecent.mockResolvedValue([
      turn({ transcript: 'wht is teh', status: 'error', error: 'network', feedback: null }),
    ]);
    mockRepos.llmInteractions.stats.mockResolvedValue(stats({ ok: 0, errors: 1 }));

    await wrap(<HistoryScreen />);
    await fireEvent.press(await screen.findByLabelText('wht is teh, failed'));

    expect(screen.getByText('WENT WRONG')).toBeTruthy();
    expect(screen.getByText('network')).toBeTruthy();
    expect(
      screen.getByText('Nothing was changed — the turn failed before it could act.'),
    ).toBeTruthy();
  });

  it('lifts the exact words back out to the clipboard', async () => {
    mockRepos.llmInteractions.listRecent.mockResolvedValue([turn()]);
    mockRepos.llmInteractions.stats.mockResolvedValue(stats());

    await wrap(<HistoryScreen />);
    await fireEvent.press(await screen.findByLabelText('add M4 bolts to the hardware list, done'));
    await fireEvent.press(screen.getByLabelText('Copy transcript'));

    expect(mockCopy).toHaveBeenCalledWith('add M4 bolts to the hardware list');
  });

  it('narrows to the turns that failed', async () => {
    mockRepos.llmInteractions.stats.mockResolvedValue(stats({ total: 4, ok: 4, errors: 0 }));

    await wrap(<HistoryScreen />);
    await waitFor(() => expect(mockRepos.llmInteractions.listRecent).toHaveBeenCalled());

    await fireEvent.press(screen.getByText('Failed'));

    await waitFor(() =>
      expect(mockRepos.llmInteractions.listRecent).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error' }),
      ),
    );
    // An empty filter over a full trail is not an empty history, and the way
    // back has to be on screen rather than at a control that scrolled away.
    expect(await screen.findByText('Nothing has failed')).toBeTruthy();
    expect(screen.getByLabelText('Show everything')).toBeTruthy();
  });

  /* This is a privacy surface. "Clear" has to really clear, and the question
     has to say what survives, or nobody can answer it honestly. */
  it('asks before clearing, in the app’s own dialog, and says what stays', async () => {
    mockRepos.llmInteractions.listRecent.mockResolvedValue([turn()]);
    mockRepos.llmInteractions.stats.mockResolvedValue(stats({ total: 12 }));
    mockRepos.llmInteractions.clear.mockResolvedValue(12);

    await wrap(<HistoryScreen />);
    await fireEvent.press(await screen.findByLabelText('Delete all history'));

    expect(await screen.findByText('Delete every transcript?')).toBeTruthy();
    expect(screen.getByText(/Your notes, tasks, events and everything else stay/)).toBeTruthy();
    expect(mockRepos.llmInteractions.clear).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText('Delete all'));

    await waitFor(() => expect(mockRepos.llmInteractions.clear).toHaveBeenCalled());
  });

  it('forgets one turn from inside the row it belongs to', async () => {
    mockRepos.llmInteractions.listRecent.mockResolvedValue([turn()]);
    mockRepos.llmInteractions.stats.mockResolvedValue(stats());

    await wrap(<HistoryScreen />);
    await fireEvent.press(await screen.findByLabelText('add M4 bolts to the hardware list, done'));
    await fireEvent.press(screen.getByLabelText('Forget this turn'));
    // The app's own dialog, never `Alert.alert`: two OS boxes that ignore the
    // palette and disagree about which button is the dangerous one.
    expect(await screen.findByText('Forget this turn?')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Forget'));

    await waitFor(() => expect(mockRepos.llmInteractions.remove).toHaveBeenCalledWith('t1'));
  });
});

describe('history formatting', () => {
  it('reads a latency the way a person would say it', () => {
    expect(formatLatency(940)).toBe('940 ms');
    expect(formatLatency(2100)).toBe('2.1 s');
    expect(formatLatency(null)).toBeNull();
  });

  it('keeps a string parameter as it was, and everything else as its JSON', () => {
    expect(formatParameter('Hardware')).toBe('Hardware');
    expect(formatParameter(3)).toBe('3');
    expect(formatParameter(['a', 'b'])).toBe('["a","b"]');
    expect(formatParameter(null)).toBe('—');
  });

  /* Buckets on the local date, like the activity feed: a 23-hour DST day is
     still one day to the person who lived it. */
  it('groups by the local day, newest bucket first', () => {
    const zone = 'Europe/Sofia';
    const today = turn({ id: 'a', createdAt: AT });
    const alsoToday = turn({ id: 'b', createdAt: AT - 3_600_000 });
    const yesterday = turn({ id: 'c', createdAt: AT - 86_400_000 });

    const days = groupByDay([today, alsoToday, yesterday], zone);
    expect(days).toHaveLength(2);
    expect(days[0]!.turns.map((t) => t.id)).toEqual(['a', 'b']);
    expect(days[1]!.turns.map((t) => t.id)).toEqual(['c']);
  });
});
