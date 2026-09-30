/**
 * One sentence can change something and ask something, and both halves have to
 * reach the screen.
 *
 * The receipt draws executor rows, and an answer read straight from CONTEXT
 * writes none — so "when is Ivo's birthday?" said to the home screen, where the
 * sheet stays shut, used to be answered to nobody. `reply` is the model's own
 * sentence, carried separately from the receipt so it can be drawn on its own
 * or underneath one.
 */
import { AccessibilityInfo } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { ThemeProvider } from '@/ui/ThemeProvider';
import { ToastProvider } from '@/ui/components';
import type { VoiceOutcomeItem } from '@/features/voice/store';

import { LastAction, asksSomething } from '../LastAction';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
}));

/* The undo runs through the same mutations the screens use, so the whole
   repository graph would come with it. What matters here is what the control
   is called and what it says about itself while it is working. */
let mockUndoPending = false;
const mockUndoRun = jest.fn(async () => {});
jest.mock('@/hooks/useVoiceUndo', () => ({
  useVoiceUndo: () => ({ run: mockUndoRun, isPending: mockUndoPending }),
}));

/* The store, as a plain object the selector reads. Same shape and same
   technique as `voice-dock-notice.test.tsx`. */
const mockState: Record<string, unknown> = {};
jest.mock('@/features/voice/store', () => ({
  useVoiceStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockState),
}));

function setStore(next: Record<string, unknown>): void {
  for (const key of Object.keys(mockState)) delete mockState[key];
  Object.assign(mockState, {
    status: 'idle',
    partial: '',
    outcome: null,
    open: jest.fn(),
    startListening: jest.fn(),
    stopListening: jest.fn(),
    // `HomeMic` reads this for the visible "TYPE" control beside its caption.
    // Nothing here presses it, so its absence would not fail as a missing
    // action — it would fail as `undefined is not a function` in whichever
    // test next reached for the keyboard.
    startTyping: jest.fn(),
    ...next,
  });
}

/** One applied action that the allow-list in `undo.ts` can take back. */
const ADDED: VoiceOutcomeItem = {
  toolName: 'task_add',
  ok: true,
  summary: 'Task added: “call Dad”',
  entityId: 'task-1',
  href: '/tasks',
};

function wrap(ui: React.ReactElement) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">
        <ToastProvider>{ui}</ToastProvider>
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

let announce: jest.SpyInstance;

beforeEach(() => {
  mockUndoPending = false;
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
});

afterEach(() => {
  announce.mockRestore();
});


const REPLY = 'Ivo’s birthday is on 14 October.';

describe('an answer reaches the home screen', () => {
  it('draws a pure answer, which has no row to draw', async () => {
    setStore({ outcome: { transcript: 'when is Ivos birthday', reply: REPLY, items: [] } });
    await wrap(<LastAction />);

    expect(screen.getByText(REPLY)).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(REPLY);
  });

  it('draws the answer under the receipt when the same sentence also changed something', async () => {
    setStore({
      outcome: { transcript: 'add a task, and when is Ivos birthday', reply: REPLY, items: [ADDED] },
    });
    await wrap(<LastAction />);

    expect(screen.getByText('Task added: “call Dad”')).toBeTruthy();
    expect(screen.getByTestId('last-action-reply')).toHaveTextContent(REPLY);
    expect(screen.getByTestId('last-action-open').props.accessibilityLabel).toBe(
      `Done. Task added: “call Dad” ${REPLY}`,
    );
  });

  it('leads with the change, not with a lookup the same sentence made', async () => {
    setStore({
      outcome: {
        transcript: 'add a task, and when is my math homework due',
        reply: 'Your math homework is due on Friday.',
        items: [ADDED, { toolName: 'search', ok: true, summary: 'One task matches “math homework”.' }],
      },
    });
    await wrap(<LastAction />);

    expect(screen.getByText('Task added: “call Dad”')).toBeTruthy();
    expect(screen.getByTestId('last-action-reply')).toHaveTextContent('Your math homework is due on Friday.');
  });

  it('leaves a plain write as a receipt, without the model restating it', async () => {
    setStore({ outcome: { transcript: 'add a task', reply: 'Added.', items: [ADDED] } });
    await wrap(<LastAction />);

    expect(screen.queryByTestId('last-action-reply')).toBeNull();
  });

  it('stays out of the way of a question the turn is still asking', async () => {
    setStore({
      outcome: {
        transcript: 'book it',
        reply: 'Book it Thursday at 14:00?',
        items: [],
        clarification: { question: 'Book it Thursday at 14:00?', answers: 'yesno' },
      },
    });
    await wrap(<LastAction />);

    expect(screen.queryByTestId('last-action')).toBeNull();
  });
});

describe('asksSomething', () => {
  it.each([
    'when is Ivos birthday',
    "I'm wondering where I parked",
    'log thirty on switches, and what is on tomorrow?',
  ])('hears a question in %p', (said) => {
    expect(asksSomething(said)).toBe(true);
  });

  it.each(['add milk to the shopping list', 'spent twelve on lunch'])('hears none in %p', (said) => {
    expect(asksSomething(said)).toBe(false);
  });
});
