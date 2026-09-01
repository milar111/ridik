/**
 * The screen that shows what Ridik counts about itself.
 *
 * This is a disclosure surface, so the tests are mostly about *claims*: that
 * the page says what it holds before it holds anything, that the retention rule
 * is stated rather than implied, that the whole vocabulary is listed including
 * the parts that have never fired, and that the export writes exactly the rows
 * the screen showed — no ids, no timestamps — as JSON. A number on this page
 * being right matters less than the sentence around it being true.
 *
 * Rendered through the **real** hooks with only `@/repositories` faked, the way
 * the history screen is tested: the query keys, the aggregation and every
 * render path are the production ones, and what is stubbed is the SQLite
 * underneath them.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { freezeClock } from '@/core/clock';
import { formatDayHeading, localToEpoch, setZoneOverride } from '@/core/time';
import type { AppEvent } from '@/repositories/appEvents';
import type { LatencySummary } from '@/repositories/llmInteractions';
import { defaultSettings } from '@/repositories/settings';

import { ThemeProvider } from '../ThemeProvider';

const mockRepos = {
  appEvents: {
    recent: jest.fn(),
    countsByName: jest.fn(),
    countsByDay: jest.fn(),
    countsByProp: jest.fn(),
    totals: jest.fn(),
    clear: jest.fn(),
  },
  llmInteractions: {
    latency: jest.fn(),
  },
  /* `useSetting` reads the whole row set; the page's opening claim is read off
     `analyticsOptIn` rather than assumed, so it has to be real here. */
  settings: {
    getAll: jest.fn(),
    set: jest.fn(),
  },
};

jest.mock('@/repositories', () => ({ getRepositories: () => mockRepos }));

/* The real export hook, with only the share sheet stubbed. The barrel it
   reaches for carries expo-print, the mail composer and the clipboard as well,
   none of which this screen touches — but `usageExportDocument` is the thing
   under test here and a stubbed one would assert this file against itself. */
const mockShareAsFile = jest.fn();
jest.mock('@/features/export', () => ({
  shareAsFile: (...args: unknown[]) => mockShareAsFile(...args),
}));

import UsageScreen, { inDeclaredOrder, readable, vocabularyCounts } from '../../../app/usage';
import { usageExportDocument, usageExportFilename } from '../../hooks/useUsageExport';

const ZONE = 'Europe/Sofia';
const AT = Date.parse('2026-09-01T09:30:00Z');

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

function latency(over: Partial<LatencySummary> = {}): LatencySummary {
  return {
    window: 100,
    turns: 40,
    timed: 38,
    medianMs: 900,
    p95Ms: 2100,
    slowestMs: 3400,
    withinTarget: true,
    ...over,
  };
}

/** Everything the screen asks of one table, keyed the way it asks for it. */
type Props = Record<string, { name: string; count: number }[]>;

function seed(options: { rows?: number; unsent?: number; byName?: [string, number][]; byDay?: [string, number][]; props?: Props } = {}) {
  const rows = options.rows ?? 0;
  mockRepos.appEvents.totals.mockResolvedValue({ rows, unsent: options.unsent ?? rows });
  mockRepos.appEvents.countsByName.mockResolvedValue(
    (options.byName ?? []).map(([name, count]) => ({ name, count })),
  );
  mockRepos.appEvents.countsByDay.mockResolvedValue(
    (options.byDay ?? []).map(([localDate, count]) => ({ localDate, count })),
  );
  const props = options.props ?? {};
  mockRepos.appEvents.countsByProp.mockImplementation((name: string, prop: string) =>
    Promise.resolve(props[`${name}.${prop}`] ?? []),
  );
}

let unfreeze = () => {};

beforeEach(() => {
  setZoneOverride(ZONE);
  unfreeze = freezeClock(AT);
  seed();
  mockRepos.appEvents.recent.mockResolvedValue([]);
  mockRepos.appEvents.clear.mockResolvedValue(undefined);
  mockRepos.settings.getAll.mockResolvedValue({ ...defaultSettings(), analyticsOptIn: false });
  mockRepos.llmInteractions.latency.mockResolvedValue(latency({ timed: 0, medianMs: null, p95Ms: null, withinTarget: null }));
  mockShareAsFile.mockResolvedValue({ ok: true, value: { uri: 'file:///usage.json', shared: true } });
});

afterEach(() => {
  unfreeze();
  setZoneOverride(null);
});

describe('usage screen', () => {
  /* Somebody privacy-minded opens this before anything is in it. "Nothing here"
     is not an answer: the page has to say what it will hold, where it is kept
     and that it has not been sent. */
  it('states the promise, and what it will hold, on a fresh install', async () => {
    await wrap(<UsageScreen />);

    expect(await screen.findByText('Nothing has been counted yet')).toBeTruthy();
    expect(screen.getByText(/not sent anywhere unless you switch that on in Settings/)).toBeTruthy();
    expect(screen.getByText(/Nothing you said, typed or saved is in it/)).toBeTruthy();
    expect(screen.getByText(/exactly what would be sent/)).toBeTruthy();
    // Nothing to export and nothing to delete, so neither offers to.
    expect(screen.queryByLabelText('Export usage')).toBeNull();
    expect(screen.queryByLabelText('Delete everything counted')).toBeNull();
  });

  /* The switch on Settings can be on. A page that still promises "this never
     leaves the phone" while it is would be the one lie this screen exists to
     make impossible, so the opening claim is read rather than assumed. */
  it('says sending is on when it is, instead of promising it never leaves', async () => {
    mockRepos.settings.getAll.mockResolvedValue({ ...defaultSettings(), analyticsOptIn: true });
    seed({ rows: 12, byName: [['turn', 12]] });

    await wrap(<UsageScreen />);

    expect(await screen.findByText(/Sending is switched on/)).toBeTruthy();
    expect(screen.getByText(/anything already sent cannot be recalled/)).toBeTruthy();
    expect(screen.queryByText(/written to this phone and nowhere else/)).toBeNull();
  });

  it('says how much is held, how much has been sent, and the retention rule', async () => {
    seed({ rows: 1240, unsent: 1240, byName: [['turn', 400]] });

    await wrap(<UsageScreen />);

    expect(await screen.findByText('1,240')).toBeTruthy();
    expect(screen.getByText('ROWS HELD')).toBeTruthy();
    // "None" rather than 0: the claim is that nothing has ever left, and a zero
    // in a counter reads as a measurement that could tick over tomorrow.
    expect(screen.getByText('None')).toBeTruthy();
    expect(screen.getByText('EVER SENT')).toBeTruthy();
    expect(
      screen.getByText(/keeps 90 days or 5,000 rows, whichever is newer/),
    ).toBeTruthy();
  });

  /* The empty rows are the disclosure. "These eleven things and nothing else"
     is a stronger statement than a list of whatever is non-zero today, so the
     whole vocabulary is drawn from EVENT_NAMES rather than from the counts. */
  it('lists every kind of row it is allowed to write, including the ones that never fired', async () => {
    seed({ rows: 3, byName: [['turn', 3]] });

    await wrap(<UsageScreen />);

    expect(await screen.findByLabelText('turn, 3')).toBeTruthy();
    expect(screen.getByLabelText('first run step, 0')).toBeTruthy();
    expect(screen.getByLabelText('permission, 0')).toBeTruthy();
    expect(screen.getByText(/Nothing outside this list can be written/)).toBeTruthy();
  });

  it('cuts turns four ways and keeps the latency buckets in bucket order', async () => {
    seed({
      rows: 30,
      byName: [['turn', 12]],
      props: {
        'turn.status': [
          { name: 'ok', count: 9 },
          { name: 'error', count: 3 },
        ],
        'turn.mode': [{ name: 'offline', count: 12 }],
        'turn.input': [{ name: 'voice', count: 12 }],
        // As `countsByProp` really answers: most frequent first, which is a
        // histogram with its axis shuffled.
        'turn.latency': [
          { name: '2-4s', count: 7 },
          { name: '<1s', count: 4 },
          { name: '8s+', count: 1 },
        ],
      },
    });

    await wrap(<UsageScreen />);

    expect(await screen.findByLabelText('Done, 9')).toBeTruthy();
    expect(screen.getByLabelText('Failed, 3')).toBeTruthy();
    expect(screen.getByLabelText('Offline matching, 12')).toBeTruthy();
    expect(screen.getByLabelText('Spoken, 12')).toBeTruthy();

    const buckets = ['<1s', '2-4s', '8s+'].map((name) => screen.getByText(name));
    const order = buckets.map((node) => node.props.children);
    expect(order).toEqual(['<1s', '2-4s', '8s+']);
  });

  it('shows which tools are load-bearing and which never fire', async () => {
    seed({
      rows: 20,
      byName: [['tool', 20]],
      props: {
        'tool.name': [
          { name: 'checklist_add', count: 14 },
          { name: 'ledger_add', count: 6 },
        ],
      },
    });

    await wrap(<UsageScreen />);

    expect(await screen.findByLabelText('checklist_add, 14')).toBeTruthy();
    expect(screen.getByLabelText('ledger_add, 6')).toBeTruthy();
    expect(screen.getByText(/Most used first/)).toBeTruthy();
  });

  it('names why turns failed, and only by code', async () => {
    seed({
      rows: 5,
      byName: [['turn_error', 5]],
      props: { 'turn_error.code': [{ name: 'offline', count: 5 }] },
    });

    await wrap(<UsageScreen />);

    expect(await screen.findByText('FAILURES')).toBeTruthy();
    expect(screen.getByText(/the code and nothing else/)).toBeTruthy();
    /* `offline` is an `AppErrorCode` here and a `turn.mode` two sections up.
       One shared label map read it as "Offline matching" in both places, which
       is a wrong answer to "why did turns fail?" — the maps are per breakdown
       for exactly this. */
    expect(screen.getByLabelText('offline, 5')).toBeTruthy();
  });

  it('breaks the ledger down by local day', async () => {
    seed({
      rows: 9,
      byName: [['turn', 9]],
      byDay: [
        ['2026-09-01', 6],
        ['2026-08-31', 3],
      ],
    });

    await wrap(<UsageScreen />);

    const today = formatDayHeading(localToEpoch('2026-09-01', ZONE), ZONE);
    expect(await screen.findByLabelText(`${today}, 6`)).toBeTruthy();
    expect(screen.getByText(/The local day is the finest time anything here is stamped with/)).toBeTruthy();
  });

  /* The one figure on the page that is not from this ledger. It has to say so,
     or the disclosure above it stops being true. */
  it('reports the reply time against the target, and says where it came from', async () => {
    seed({ rows: 4, byName: [['turn', 4]] });
    mockRepos.llmInteractions.latency.mockResolvedValue(latency({ p95Ms: 6400, withinTarget: false }));

    await wrap(<UsageScreen />);

    expect(await screen.findByText('900 ms typical · 95% under 6.4 s')).toBeTruthy();
    expect(screen.getByText(/The slow tail is past the 4.0 s it is held to/)).toBeTruthy();
    expect(screen.getByText(/Only the bucket above ever leaves it/)).toBeTruthy();
  });

  it('writes the ledger out as the upload, through the app’s own share sheet', async () => {
    const event: AppEvent = {
      id: 'e1',
      name: 'turn',
      props: { mode: 'offline', status: 'ok' },
      localDate: '2026-09-01',
      createdAt: AT,
      uploadedAt: null,
    };
    seed({ rows: 1, byName: [['turn', 1]] });
    mockRepos.appEvents.recent.mockResolvedValue([event]);

    await wrap(<UsageScreen />);
    await fireEvent.press(await screen.findByLabelText('Export usage'));

    await waitFor(() => expect(mockShareAsFile).toHaveBeenCalled());
    const [body, filename, options] = mockShareAsFile.mock.calls[0] as [
      string,
      string,
      { mimeType?: string; uti?: string },
    ];

    expect(filename).toBe('ridik-usage-2026-09-01.json');
    // Not `text/markdown`: a JSON export handed out under the markdown UTI is
    // offered to the wrong apps and refused by the right ones.
    expect(options.mimeType).toBe('application/json');
    expect(options.uti).toBe('public.json');

    const parsed = JSON.parse(body) as { events: Record<string, unknown>[] };
    expect(parsed.events).toEqual([
      { name: 'turn', props: { mode: 'offline', status: 'ok' }, local_date: '2026-09-01' },
    ]);
  });

  /* A privacy surface. Clear has to really clear, the question has to be the
     app's own dialog rather than `Alert.alert`, and it has to say what survives
     or nobody can answer it honestly. */
  it('asks before clearing, and says what stays', async () => {
    seed({ rows: 88, byName: [['turn', 88]] });

    await wrap(<UsageScreen />);
    await fireEvent.press(await screen.findByLabelText('Delete everything counted'));

    expect(await screen.findByText('Delete everything counted?')).toBeTruthy();
    expect(screen.getByText(/88 rows go/)).toBeTruthy();
    expect(screen.getByText(/transcripts and habits are untouched/)).toBeTruthy();
    expect(mockRepos.appEvents.clear).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText('Delete all'));

    await waitFor(() => expect(mockRepos.appEvents.clear).toHaveBeenCalled());
  });

  it('keeps the day on screen and offers a way back when the read fails', async () => {
    mockRepos.appEvents.totals.mockRejectedValue(new Error('database is locked'));

    await wrap(<UsageScreen />);

    expect(await screen.findByLabelText('Retry')).toBeTruthy();
  });
});

/* ------------------------------------------------------------------- pure */

describe('usage formatting', () => {
  it('reads an enum value as a sentence, and falls back rather than vanishing', () => {
    expect(readable('carry_on', { carry_on: 'Carried on' })).toBe('Carried on');
    // No map of its own: the underscores go and the value survives, so a value
    // added to the vocabulary tomorrow is legible rather than missing.
    expect(readable('permission_denied')).toBe('permission denied');
    expect(readable('low_confidence')).toBe('low confidence');
    // What `json_extract`'s coalesce writes when a property is absent. It comes
    // from the query rather than the vocabulary, so it is handled everywhere.
    expect(readable('null')).toBe('Not recorded');
  });

  it('puts a breakdown back into its declared order and keeps strangers at the end', () => {
    const entries = [
      { name: '2-4s', count: 7 },
      { name: 'from-the-future', count: 1 },
      { name: '<1s', count: 4 },
    ];
    expect(inDeclaredOrder(entries, ['<1s', '1-2s', '2-4s']).map((e) => e.name)).toEqual([
      '<1s',
      '2-4s',
      'from-the-future',
    ]);
  });

  it('lists the whole vocabulary at zero, and never hides a row it cannot explain', () => {
    const counts = vocabularyCounts([
      { name: 'turn', count: 4 },
      { name: 'from-an-older-build', count: 2 },
    ]);

    expect(counts.find((entry) => entry.name === 'turn')?.count).toBe(4);
    expect(counts.find((entry) => entry.name === 'stt')?.count).toBe(0);
    expect(counts.at(-1)).toEqual({ name: 'from-an-older-build', count: 2 });
  });
});

describe('the usage export document', () => {
  /* The file *is* the upload. An id is a join key nobody on the receiving end
     should be handed, and `created_at` is a timestamp finer than anything the
     screen showed — so neither may survive into the document. */
  it('drops the row id and every time finer than the day', () => {
    const event: AppEvent = {
      id: 'e1',
      name: 'screen',
      props: { route: 'usage' },
      localDate: '2026-09-01',
      createdAt: AT,
      uploadedAt: null,
    };

    const document = usageExportDocument([event], { rows: 1, unsent: 1 }, '2026-09-01');

    expect(document.events).toEqual([
      { name: 'screen', props: { route: 'usage' }, local_date: '2026-09-01' },
    ]);
    expect(JSON.stringify(document)).not.toContain('e1');
    expect(JSON.stringify(document)).not.toContain(String(AT));
    expect(document.retention).toEqual({ days: 90, rows: 5000 });
    expect(usageExportFilename('2026-09-01')).toBe('ridik-usage-2026-09-01.json');
  });
});
