/**
 * The conversation on home, and the rule that it matches what the model has.
 *
 * Most of this is `recentLines`, which is pure and is where the decisions are.
 * The render test at the bottom exists for the one thing a pure function cannot
 * promise: that nothing is drawn when there is nothing to draw. An empty
 * bordered box on the resting screen is the defect `Card` returns null for, and
 * it is the state this component is in most of the time.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { freezeClock } from '@/core/clock';
import { useVoiceStore } from '@/features/voice/store';
import { RECALL_TURNS, RECALL_WINDOW_MS } from '@/llm/recall';
import type { Interaction, InteractionAction } from '@/repositories/llmInteractions';
import { ThemeProvider } from '@/ui/ThemeProvider';

const NOW = 1_772_000_000_000;

let mockTurns: Interaction[] = [];
let mockNotes: { id: string; titleSummary: string; bullets: { content: string }[] }[] = [];
jest.mock('@/hooks', () => {
  // Mocked *as hooks*: a mock that calls no hook of its own makes the counts
  // match and hides the crash a `SectionBoundary` would swallow. See AGENTS.md.
  const { useRef } = jest.requireActual('react') as typeof import('react');
  return {
    useInteractionHistory: () => {
      useRef(null);
      return { data: mockTurns };
    },
    useNotes: () => {
      useRef(null);
      return { data: mockNotes };
    },
  };
});

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

import { HomePanel } from '../HomePanel';
import { recentLines } from '../RecentTurns';

function action(over: Partial<InteractionAction> = {}): InteractionAction {
  return {
    toolName: 'checklist_add',
    parameters: null,
    ok: true,
    summary: 'Added flowers to Shopping',
    error: null,
    asked: null,
    ...over,
  };
}

function turn(over: Partial<Interaction> = {}): Interaction {
  return {
    id: 'i1',
    transcript: 'Add flowers to my list.',
    confidence: 0.95,
    rawResponse: null,
    actions: null,
    feedback: 'Added flowers to the shopping list.',
    status: 'ok',
    error: null,
    latencyMs: 900,
    model: 'mock-1',
    createdAt: NOW - 20_000,
    parsedActions: [action()],
    ...over,
  } as Interaction;
}

const lines = (rows: Interaction[], liveTranscript?: string) =>
  recentLines(rows, { at: NOW, liveTranscript });

describe('which turns are on the screen', () => {
  it('reads oldest first, downwards into the live receipt', () => {
    const rows = [
      turn({ id: 'b', transcript: 'Toilet paper.', createdAt: NOW - 5_000 }),
      turn({ id: 'a', transcript: 'Add flowers to my list.', createdAt: NOW - 20_000 }),
    ];
    expect(lines(rows).map((l) => l.said)).toEqual(['Add flowers to my list.', 'Toilet paper.']);
  });

  /*
    The window is `RECALL_WINDOW_MS` because that is what `src/llm/recall.ts`
    sends to the model. The two are one decision: a fragment works because the
    turn above it is still in play, and showing a turn the model no longer has
    would promise a continuation that cannot happen.
  */
  it('ends exactly where the model stops being given the conversation', () => {
    const rows = [
      turn({ id: 'in', transcript: 'Toilet paper.', createdAt: NOW - RECALL_WINDOW_MS }),
      turn({ id: 'out', transcript: 'Book the dentist.', createdAt: NOW - RECALL_WINDOW_MS - 1 }),
    ];
    expect(lines(rows).map((l) => l.said)).toEqual(['Toilet paper.']);
  });

  it('carries at most as many turns as the model does', () => {
    const rows = Array.from({ length: RECALL_TURNS + 3 }, (_, i) =>
      turn({ id: `t${i}`, transcript: `Utterance ${i}.`, createdAt: NOW - i * 1_000 }),
    );
    expect(lines(rows)).toHaveLength(RECALL_TURNS);
  });

  /* `LastAction` is directly underneath with the tick and the undo. The same
     turn drawn twice is a receipt above a receipt, the upper one inert. */
  it('leaves the live turn to the receipt below it', () => {
    const rows = [
      turn({ id: 'live', transcript: 'Toilet paper.', createdAt: NOW - 1_000 }),
      turn({ id: 'before', transcript: 'Add flowers to my list.', createdAt: NOW - 20_000 }),
    ];
    expect(lines(rows, 'Toilet paper.').map((l) => l.said)).toEqual(['Add flowers to my list.']);
  });

  /* Only the newest can be the live one. Saying the same thing twice in an
     evening is ordinary, and both times are worth keeping. */
  it('keeps an identical sentence from earlier in the conversation', () => {
    const rows = [
      turn({ id: 'live', transcript: 'Toilet paper.', createdAt: NOW - 1_000 }),
      turn({ id: 'earlier', transcript: 'Toilet paper.', createdAt: NOW - 200_000 }),
    ];
    expect(lines(rows, 'Toilet paper.')).toHaveLength(1);
  });
});

describe('what each turn says it did', () => {
  it('names the row that was written', () => {
    expect(lines([turn()])[0]!.did).toBe('Added flowers to Shopping');
  });

  it('counts the rest of a batch rather than listing it', () => {
    const rows = [turn({ parsedActions: [action(), action({ summary: 'Logged 12 on lunch' })] })];
    expect(lines(rows)[0]!.did).toBe('Logged 12 on lunch, and 1 more');
  });

  it('shows the question when the turn stopped on one', () => {
    const rows = [
      turn({
        status: 'clarify',
        feedback: 'I need a time first.',
        parsedActions: [action({ ok: false, summary: null, asked: 'Book it tomorrow at 10:00?' })],
      }),
    ];
    expect(lines(rows)[0]!.did).toBe('Book it tomorrow at 10:00?');
  });

  /* A turn that wrote nothing still said something — under RULE 18 in
     `prompt.ts` a statement is captured rather than refused, so this is the
     answer to a question, and the spoken sentence is the whole of it. */
  it('falls back to what was spoken when nothing was written', () => {
    const rows = [turn({ feedback: 'Two lists: Shopping and Hardware.', parsedActions: [] })];
    expect(lines(rows)[0]!.did).toBe('Two lists: Shopping and Hardware.');
  });

  it('says plainly when a turn failed', () => {
    const rows = [turn({ status: 'error', feedback: null, parsedActions: [] })];
    expect(lines(rows)[0]!.did).toBe('That one did not land.');
  });

  it('drops a turn with nothing to say on either line', () => {
    expect(lines([turn({ transcript: '  ', feedback: null, parsedActions: [] })])).toEqual([]);
  });
});

const aNote = (id: string, title: string, first: string) => ({
  id,
  titleSummary: title,
  bullets: [{ content: first }],
});

describe('the panel on home', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = freezeClock(NOW);
    mockTurns = [];
    mockNotes = [];
    mockPush.mockReset();
    useVoiceStore.getState().reset();
  });
  afterEach(() => restore());

  const wrap = () =>
    render(
      <ThemeProvider>
        <QueryClientProvider client={new QueryClient()}>
          <HomePanel />
        </QueryClientProvider>
      </ThemeProvider>,
    );

  /* A fresh install: nothing said, nothing kept. Home is a microphone, and a
     box with nothing in it is furniture — the argument that took a list of
     example sentences out of this exact slot. */
  it('draws nothing at all on an install with neither', async () => {
    await wrap();
    expect(screen.queryByTestId('recent-turns')).toBeNull();
    expect(screen.queryByTestId('kept-notes')).toBeNull();
  });

  it('shows the words that were said and what came of them', async () => {
    mockTurns = [turn({ createdAt: NOW - 30_000 })];
    await wrap();
    expect(screen.getByTestId('recent-turns')).toBeTruthy();
    expect(screen.getByText('“Add flowers to my list.”')).toBeTruthy();
    expect(screen.getByText('Added flowers to Shopping')).toBeTruthy();
  });

  /* The conversation leads whenever there is one — it is what the user is in
     the middle of, and the notes are not going anywhere. */
  it('opens on the conversation when there is one', async () => {
    mockTurns = [turn({ createdAt: NOW - 30_000 })];
    mockNotes = [aNote('n1', 'Door Codes', 'Bike Room: 0451')];
    await wrap();
    expect(screen.getByTestId('recent-turns')).toBeTruthy();
    expect(screen.queryByText('Door Codes')).toBeNull();
  });

  /* And the rest of the time — which is most of the time — it is the notes,
     because that is what this app mostly produces and they were two taps away
     behind the menu. */
  it('opens on the notes once the conversation has lapsed', async () => {
    mockTurns = [turn({ createdAt: NOW - RECALL_WINDOW_MS - 1 })];
    mockNotes = [aNote('n1', 'Door Codes', 'Bike Room: 0451')];
    await wrap();
    expect(screen.getByTestId('kept-notes')).toBeTruthy();
    expect(screen.getByText('Door Codes')).toBeTruthy();
    expect(screen.getByText('Bike Room: 0451')).toBeTruthy();
  });

  /* One reachable option is not a choice. With only one side populated the
     control is decoration on the screen with the least room for any. */
  it('offers no toggle when only one side has anything', async () => {
    mockNotes = [aNote('n1', 'Door Codes', 'Bike Room: 0451')];
    await wrap();
    expect(screen.queryByText('Said')).toBeNull();
    expect(screen.queryByText('Kept')).toBeNull();
  });

  it('switches sides when both have something', async () => {
    mockTurns = [turn({ createdAt: NOW - 30_000 })];
    mockNotes = [aNote('n1', 'Door Codes', 'Bike Room: 0451')];
    await wrap();

    await fireEvent.press(screen.getByText('Kept'));
    expect(screen.getByTestId('kept-notes')).toBeTruthy();
    expect(screen.getByText('Door Codes')).toBeTruthy();

    await fireEvent.press(screen.getByText('Said'));
    expect(screen.getByTestId('recent-turns')).toBeTruthy();
  });

  it('opens a note from home', async () => {
    mockNotes = [aNote('n1', 'Door Codes', 'Bike Room: 0451')];
    await wrap();
    await fireEvent.press(screen.getByText('Door Codes'));
    expect(mockPush).toHaveBeenCalledWith('/note/n1');
  });

  /* A shortlist that just stops is one whose only clue that there is more is
     that what you remember is missing. */
  it('offers the way out to the whole screen', async () => {
    mockNotes = [aNote('n1', 'Door Codes', 'Bike Room: 0451')];
    await wrap();
    await fireEvent.press(screen.getByTestId('kept-notes-all'));
    expect(mockPush).toHaveBeenCalledWith('/notes');
  });
});
