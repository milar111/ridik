/**
 * The receipt has to be announced, or the safety model does not exist.
 *
 * This app is safe because it shows you what it did: `LastAction` names the
 * action, and undo sits on it. Both of those are a card that springs up — and a
 * screen reader does not read a view because it appeared, it reads what has
 * focus, and focus does not move. So for a VoiceOver or TalkBack user the
 * receipt was not a degraded experience, it was absent: a mis-heard word landed
 * in silence and stayed wrong, which is the one failure the whole home screen
 * is arranged to prevent.
 *
 * Two mechanisms, one per platform, and asserting both is the point of this
 * file: the Android half is a prop (`accessibilityLiveRegion`) and can be read
 * off the tree; the iOS half is a call (`announceForAccessibility`) and can be
 * spied on. These tests run with `Platform.OS === 'ios'`, so the call is the
 * one that fires here; the prop is asserted as a prop, which is all a test on
 * this side of a device can do.
 *
 * What is NOT proved here, and needs a human with a device: that TalkBack
 * actually speaks a live region on a view that was just added, and that neither
 * platform says the same sentence twice.
 */
import { AccessibilityInfo } from 'react-native';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { ThemeProvider } from '@/ui/ThemeProvider';
import { ToastProvider } from '@/ui/components';
import type { VoiceOutcomeItem } from '@/features/voice/store';

import { HomeMic } from '../HomeMic';
import { LastAction } from '../LastAction';

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

describe('the receipt announces itself', () => {
  it('says what landed, rather than only drawing it', async () => {
    setStore({ outcome: { transcript: 'add a task', items: [ADDED] } });
    await wrap(<LastAction />);

    expect(announce).toHaveBeenCalledWith('Done. Task added: “call Dad”');
  });

  /* The Android half of the same sentence. The card is the element whose own
     words are the news, so it is the element that carries the region. */
  it('is a live region, so TalkBack reads it without being asked', async () => {
    setStore({ outcome: { transcript: 'add a task', items: [ADDED] } });
    await wrap(<LastAction />);

    expect(screen.getByTestId('last-action').props.accessibilityLiveRegion).toBe('polite');
  });

  /* "and 2 more" is a second line under the summary and the tick is a colour.
     Neither survives into a label that does not mention them. */
  it('counts the rest of a multi-part sentence in the one label', async () => {
    setStore({
      outcome: {
        transcript: 'two things',
        items: [
          { toolName: 'note_create', ok: true, summary: 'Note saved' },
          ADDED,
        ],
      },
    });
    await wrap(<LastAction />);

    expect(screen.getByTestId('last-action-open').props.accessibilityLabel).toBe(
      'Done. Task added: “call Dad”, and 1 more',
    );
  });

  /* Nothing to report is silence, not "Done." with an empty sentence. */
  it('says nothing when nothing was applied', async () => {
    setStore({ outcome: { transcript: 'nope', items: [{ toolName: 'task_add', ok: false, summary: 'No' }] } });
    await wrap(<LastAction />);

    expect(announce).not.toHaveBeenCalled();
    expect(screen.queryByTestId('last-action')).toBeNull();
  });
});

describe('undo is reachable and says what it does', () => {
  it('names what it would take back', async () => {
    setStore({ outcome: { transcript: 'add a task', items: [ADDED] } });
    await wrap(<LastAction />);

    const undo = screen.getByTestId('last-action-undo');
    expect(undo.props.accessibilityLabel).toBe('Undo Task added: “call Dad”');
    expect(undo.props.accessibilityRole).toBe('button');
    expect(undo.props.accessibilityHint).toBeTruthy();
  });

  /* In flight, the only sign is a 50% dim — which is nothing at all here. */
  it('reports that it is working as state and not as a dim', async () => {
    mockUndoPending = true;
    setStore({ outcome: { transcript: 'add a task', items: [ADDED] } });
    await wrap(<LastAction />);

    const undo = screen.getByTestId('last-action-undo');
    expect(undo.props.accessibilityState).toEqual(
      expect.objectContaining({ busy: true, disabled: true }),
    );
    expect(undo.props.accessibilityLabel).toBe('Undoing Task added: “call Dad”');
  });

  /* And the result is announced: the card stays put, greys itself and swaps a
     tick for an arrow, none of which a screen reader can see. */
  it('announces that the action was taken back', async () => {
    setStore({ outcome: { transcript: 'add a task', items: [ADDED] } });
    await wrap(<LastAction />);
    announce.mockClear();

    await fireEvent.press(screen.getByTestId('last-action-undo'));

    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith('Undone. Task added: “call Dad”'),
    );
  });
});

describe('the microphone says what it is doing', () => {
  it('announces the state it moved to', async () => {
    setStore({ status: 'idle' });
    const view = await wrap(<HomeMic />);
    // Mounting idle must not talk over the screen's own arrival.
    expect(announce).not.toHaveBeenCalled();

    setStore({ status: 'listening' });
    await act(async () => {
      await view.rerender(
        <SafeAreaProvider initialMetrics={METRICS}>
          <ThemeProvider forceScheme="dark">
            <ToastProvider>
              <HomeMic />
            </ToastProvider>
          </ThemeProvider>
        </SafeAreaProvider>,
      );
    });

    expect(announce).toHaveBeenCalledWith('Listening. Tap to send.');
  });

  it('reads the caption as a sentence rather than as shouting', async () => {
    setStore({ status: 'thinking' });
    await wrap(<HomeMic />);

    const caption = screen.getByTestId('home-mic-caption');
    expect(caption.props.accessibilityLabel).toBe('Working on it.');
    expect(caption.props.accessibilityLiveRegion).toBe('polite');
  });

  /**
   * The one case a live region would be unusable in: while you speak, this line
   * *is* the partial transcript, and a region on it interrupts TalkBack on
   * every syllable of your own sentence.
   */
  it('stops announcing while the caption is the words being heard', async () => {
    setStore({ status: 'listening', partial: 'add milk to' });
    await wrap(<HomeMic />);

    const caption = screen.getByTestId('home-mic-caption');
    expect(caption.props.accessibilityLiveRegion).toBe('none');
    expect(caption.props.accessibilityLabel).toBe('add milk to');
    expect(announce).not.toHaveBeenCalled();
  });

  it('exposes working as state, not as a swapped glyph', async () => {
    setStore({ status: 'thinking' });
    await wrap(<HomeMic />);

    expect(screen.getByTestId('home-mic').props.accessibilityState).toEqual(
      expect.objectContaining({ busy: true }),
    );
  });
});
