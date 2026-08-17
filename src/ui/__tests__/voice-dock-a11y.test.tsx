/**
 * A question the user cannot hear is a question they will answer yes to.
 *
 * The voice sheet carries the three things that make speaking safe: the
 * clarification — which is also how the review gate previews a write *before*
 * it lands — the failure, and the notice that says the assistant has quietly
 * stopped calling the model. All three shipped as a card that slides up in
 * silence. With VoiceOver or TalkBack on, the sheet appears, focus stays where
 * it was, and the only thing on it a screen reader ever reached first was an
 * unnamed backdrop and a decorative grab handle.
 *
 * So: the words are announced (iOS) and marked as a live region (Android), the
 * sheet has a Close that is a control rather than a gesture, and a result the
 * app could not apply says so in words rather than in the colour of a glyph.
 *
 * Same store-as-an-object technique as `voice-dock-notice.test.tsx`.
 */
import { AccessibilityInfo } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '../ThemeProvider';

/** Home is the screen most turns are taken from; the dock draws no mic there. */
let mockPathname = '/';

jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

jest.mock('@/features/voice/useQuickActions', () => ({
  useQuickActionRouting: () => {},
}));

const mockClose = jest.fn();
const mockState: Record<string, unknown> = {};

jest.mock('@/features/voice/store', () => ({
  useVoiceStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockState),
}));

function setStore(overrides: Record<string, unknown> = {}): void {
  for (const key of Object.keys(mockState)) delete mockState[key];
  Object.assign(mockState, {
    status: 'idle',
    expanded: true,
    partial: '',
    transcript: '',
    error: null,
    needsRetry: false,
    sttUnavailable: false,
    heardNothing: false,
    outcome: undefined,
    pendingClarification: null,
    // Typing is store state rather than the dock's own, because the mic on home
    // and the control beside its caption both ask for the text box from outside
    // this component. And the transcript-keeping slot travels with it: a stub
    // missing an action does not fail as a missing action, it fails as
    // `undefined is not a function` inside an unrelated effect.
    typing: false,
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
    open: jest.fn(),
    ...overrides,
  });
}

async function mount(): Promise<void> {
  // `require`, not a dynamic import: this project's jest runs without
  // --experimental-vm-modules. jest.mock is hoisted above it either way.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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

let announce: jest.SpyInstance;

beforeEach(() => {
  mockPathname = '/';
  mockClose.mockClear();
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
});

afterEach(() => {
  announce.mockRestore();
});

describe('the question is spoken, not only drawn', () => {
  it('announces a clarification', async () => {
    setStore({ pendingClarification: { question: 'Which Alex — Alex Ross or Alex Kim?' } });
    await mount();

    expect(announce).toHaveBeenCalledWith('Ridik asks: Which Alex — Alex Ross or Alex Kim?');
  });

  /* The review gate rides the same envelope: its preview of a write that has
     not happened yet arrives as a clarification, and it is the one question
     where a blind yes writes something the user never saw. */
  it('announces the review gate the same way', async () => {
    setStore({
      pendingClarification: { question: 'Add to calendar — Title: Gym, Starts: 15:00?' },
    });
    await mount();

    expect(announce).toHaveBeenCalledWith(
      'Ridik asks: Add to calendar — Title: Gym, Starts: 15:00?',
    );
  });

  /* The Android half, plus the prefix: the question mark is carried by a help
     glyph, and the block is grouped so it reads as one thing rather than as an
     unexplained sentence next to an unnamed icon. */
  it('is an assertive live region with the asking said out loud', async () => {
    setStore({ pendingClarification: { question: 'Which Alex?' } });
    await mount();

    const block = screen.getByLabelText('Ridik asks: Which Alex?');
    expect(block.props.accessibilityLiveRegion).toBe('assertive');
    expect(block.props.accessibilityRole).toBe('alert');
  });

  /* The answer box has to say what it is answering: a text field whose only
     description is "Your answer…" is a placeholder, and a placeholder is a hint
     on one platform and the label on the other. */
  it('labels the answer box with the question it answers', async () => {
    setStore({ pendingClarification: { question: 'Which Alex?' } });
    await mount();

    expect(screen.getByTestId('voice-text-input').props.accessibilityLabel).toBe(
      'Your answer to: Which Alex?',
    );
  });
});

describe('failures and notices are heard', () => {
  it('announces a failure and marks it as one', async () => {
    setStore({ status: 'error', error: 'That did not go through.' });
    await mount();

    expect(announce).toHaveBeenCalledWith('That did not go through.');
    const line = screen.getByText('That did not go through.');
    expect(line.props.accessibilityLiveRegion).toBe('assertive');
    expect(line.props.accessibilityRole).toBe('alert');
  });

  it('announces the "try again" wording, which is what the sheet prints', async () => {
    setStore({ status: 'error', error: 'no speech', needsRetry: true });
    await mount();

    expect(announce).toHaveBeenCalledWith("I didn't catch that clearly. Try again?");
  });

  /* The sentence that says the assistant has stopped calling the model. Drawn
     and, until now, never spoken — which is the same silence the receipt exists
     to prevent, arriving through a different door. */
  it('announces the notice and reads it as a live region', async () => {
    setStore({
      outcome: {
        items: [],
        notice: "You've used your free assistant requests.",
        noticeAction: { label: 'See plans', href: '/plans' },
      },
    });
    await mount();

    expect(announce).toHaveBeenCalledWith("You've used your free assistant requests.");
    expect(
      screen.getByText("You've used your free assistant requests.").props.accessibilityLiveRegion,
    ).toBe('polite');
  });

  /**
   * One sentence per turn on iOS. Announcements made in the same commit
   * interrupt each other, so three of them means the user hears whichever
   * happened to be last — and the one that must survive is the question.
   */
  it('says the question rather than three things at once', async () => {
    setStore({
      pendingClarification: { question: 'Which Alex?' },
      error: 'That did not go through.',
      outcome: { items: [], notice: 'Offline for now.' },
    });
    await mount();

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Ridik asks: Which Alex?');
  });

  /* On home the mic itself is the control and announces its own state. Two
     components saying "Working on it" is the "nothing announces twice" rule
     breaking in the one place both are mounted at once. */
  it('leaves the status to the home mic when it is on home', async () => {
    setStore({ status: 'thinking', expanded: true });
    await mount();

    expect(announce).not.toHaveBeenCalled();
  });

  it('reports the status itself on every other screen', async () => {
    mockPathname = '/tasks';
    setStore({ status: 'thinking', expanded: true });
    await mount();

    expect(announce).toHaveBeenCalledWith('Working on it.');
    expect(screen.getByText('Working on it…').props.accessibilityLiveRegion).toBe('polite');
  });
});

describe('a turn taken away from home still gets a receipt', () => {
  /* `LastAction` is a home-screen component. On every other screen this list is
     the only report a turn ever gets, and it arrived silently. */
  it('announces what landed', async () => {
    mockPathname = '/notes';
    setStore({
      outcome: {
        items: [
          { toolName: 'note_create', ok: true, summary: 'Note saved' },
          { toolName: 'task_add', ok: true, summary: 'Task added: milk', href: '/tasks' },
        ],
      },
    });
    await mount();

    expect(announce).toHaveBeenCalledWith('Done. Task added: milk, and 1 more');
  });

  /* On home the card under the microphone is the receipt and announces itself;
     the dock saying it as well is the same result read twice. */
  it('leaves that to the receipt on home', async () => {
    // A notice is the ordinary reason the sheet is open on home at all, and it
    // is what should be heard there — the result itself belongs to the card
    // under the microphone.
    setStore({
      outcome: {
        items: [{ toolName: 'task_add', ok: true, summary: 'Task added: milk' }],
        notice: 'Offline for now.',
      },
    });
    await mount();

    expect(announce).toHaveBeenCalledWith('Offline for now.');
    expect(announce).not.toHaveBeenCalledWith('Done. Task added: milk');
    expect(screen.getByLabelText('Done. Task added: milk').props.accessibilityLiveRegion).toBeUndefined();
  });
});

describe('the sheet can be left', () => {
  /* It shipped with a drag as its only exit and a `View` carrying the label —
     which is not an accessibility element at all unless it is told to be, and
     whose `onAccessibilityTap` is iOS-only. On Android that left system Back;
     on iOS it left nothing. */
  it('draws a Close that is a control rather than a gesture', async () => {
    setStore({ status: 'error', error: 'That did not go through.' });
    await mount();

    const close = screen.getByTestId('voice-sheet-close');
    expect(close.props.accessibilityRole).toBe('button');
    expect(close.props.accessibilityLabel).toBe('Close');

    await fireEvent.press(close);
    expect(mockClose).toHaveBeenCalled();
  });

  it('names the backdrop, which is the other thing a swipe lands on', async () => {
    setStore({ status: 'error', error: 'That did not go through.' });
    await mount();

    expect(screen.getByLabelText('Dismiss')).toBeTruthy();
  });
});

describe('the results list says what happened to each one', () => {
  it('does not leave "it failed" to the colour of a glyph', async () => {
    setStore({
      outcome: {
        items: [
          { toolName: 'task_add', ok: true, summary: 'Task added: milk', href: '/tasks' },
          { toolName: 'calendar_add', ok: false, summary: 'Could not add Gym', detail: 'No time given' },
        ],
        notice: 'Offline for now.',
      },
    });
    await mount();

    expect(screen.getByLabelText('Done. Task added: milk')).toBeTruthy();
    const failed = screen.getByLabelText('Not done. Could not add Gym. No time given');
    // Nothing to open, so nothing to press — and that is state, not silence.
    expect(failed.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
  });
});
