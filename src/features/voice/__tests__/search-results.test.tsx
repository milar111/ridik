/**
 * A question deserves its answer, not a count of it.
 *
 * `search` spans notes, tasks, checklists, projects, people, money and the
 * calendar with FTS5 behind it, and it came back through the same one-line
 * summary every other tool uses: "Found 6 matches for “resistors”: 3 notes and
 * 3 tasks." — with the six labels crushed into a comma-joined `detail` under
 * it, none of which could be opened. The answer to a question is the list.
 *
 * Mocked the way `voice-dock-notice.test.tsx` mocks it, for the same reason:
 * this asserts the *rendering*, and the executor tests already prove the rows
 * are produced.
 */
import { render, screen, fireEvent } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '@/ui/ThemeProvider';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

jest.mock('@/features/voice/useQuickActions', () => ({
  useQuickActionRouting: () => {},
}));

const mockClose = jest.fn();
const mockState: Record<string, unknown> = {};

jest.mock('@/features/voice/store', () => ({
  useVoiceStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockState),
}));

const HITS = [
  { label: 'Resistor stock', scope: 'note', href: '/note/n1' },
  { label: 'Order resistors', scope: 'task', href: '/tasks' },
  { label: '€4.20 · components', scope: 'transaction' },
];

function setStore(items: unknown[]): void {
  for (const key of Object.keys(mockState)) delete mockState[key];
  Object.assign(mockState, {
    status: 'idle',
    expanded: true,
    typing: false,
    partial: '',
    transcript: 'what have I got about resistors',
    error: null,
    needsRetry: false,
    sttUnavailable: false,
    heardNothing: false,
    outcome: { transcript: 'what have I got about resistors', items },
    pendingClarification: null,
    // The transcript-keeping half of the store. Nothing here dismisses the
    // sheet with words in it, so a missing `keepDraft` would not fail as a
    // missing action — it would fail as `undefined is not a function` in
    // whichever test next reached for the backdrop.
    recovered: null,
    draftSeed: null,
    startListening: jest.fn(),
    stopListening: jest.fn(),
    submitText: jest.fn(),
    setTyping: jest.fn(),
    startTyping: jest.fn(),
    recoverTranscript: jest.fn(),
    discardRecovered: jest.fn(),
    keepDraft: jest.fn(),
    consumeDraftSeed: jest.fn(),
    close: mockClose,
  });
}

async function mount(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { VoiceDock } = require('@/features/voice/VoiceDock');
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>
          <VoiceDock />
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  mockPush.mockReset();
  mockClose.mockReset();
});

describe('what a search comes back as', () => {
  it('lists what it found', async () => {
    setStore([
      {
        toolName: 'search',
        ok: true,
        summary: 'Found 3 matches for “resistors”: 1 note, 1 task and 1 transaction.',
        href: '/note/n1',
        results: HITS,
      },
    ]);
    await mount();

    for (const hit of HITS) expect(screen.getByText(hit.label)).toBeTruthy();
  });

  /* Which scope a hit came from is half the answer: "Resistors" means one thing
     as a note and another as a task, and finding both is the point. */
  it('says what each one is', async () => {
    setStore([
      { toolName: 'search', ok: true, summary: 'Found 3 matches.', results: HITS },
    ]);
    await mount();

    expect(screen.getByText('note')).toBeTruthy();
    expect(screen.getByText('task')).toBeTruthy();
  });

  it('opens the one you press, and gets out of the way', async () => {
    setStore([
      { toolName: 'search', ok: true, summary: 'Found 3 matches.', results: HITS },
    ]);
    await mount();

    await fireEvent.press(screen.getByText('Order resistors'));

    expect(mockClose).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/tasks');
  });

  /* A row with nowhere to go is not a dead tap — it is not a link at all, and
     it does not announce itself as one either. */
  it('offers no link for a row with no screen behind it', async () => {
    setStore([
      { toolName: 'search', ok: true, summary: 'Found 3 matches.', results: HITS },
    ]);
    await mount();

    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getByLabelText('€4.20 · components, transaction')).toBeTruthy();
  });

  /**
   * And the rule that makes the list reachable at all.
   *
   * On home the sheet stays shut unless something genuinely needs it — the
   * screen is already the voice interface, and a scrim over it hides the whole
   * product. A receipt does not need it: "Task added" is one line and
   * `LastAction` draws it in place. An answer does, because an answer is a
   * list, and there is nowhere else on that screen to put one.
   */
  it('opens the sheet on home, where a receipt would not have', async () => {
    setStore([
      { toolName: 'search', ok: true, summary: 'Found 3 matches.', results: HITS },
    ]);
    await mount();

    expect(screen.getByText('Resistor stock')).toBeTruthy();
  });

  it('leaves home alone for an ordinary receipt', async () => {
    setStore([{ toolName: 'task_add', ok: true, summary: 'Task added: “call Dad”.' }]);
    await mount();

    expect(screen.queryByText('Task added: “call Dad”.')).toBeNull();
  });
});
