/**
 * The notice has to reach the screen most turns are taken from.
 *
 * `outcome.notice` is the sentence that says the assistant has stopped calling
 * the model — the trial is spent, or a cap is reached, and voice has quietly
 * dropped to offline pattern matching. It shipped computed and rendered
 * nowhere: on home the sheet only opened for a clarification, an error or
 * typing, and a notice was none of those, so the one screen the user is
 * actually looking at showed nothing at all.
 *
 * That is the exact failure `LastAction` exists to prevent, arriving through a
 * different door. An assistant that has become dumber and does not say so is
 * worse than one that has stopped, because the user keeps talking to it.
 *
 * The pipeline tests already prove the notice is *produced*. Nothing proved it
 * was *shown*, and the gap between those two is where the bug lived — so this
 * asserts the rendering condition rather than the data.
 */
import { render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '../ThemeProvider';

/** Home is the case that regressed; the others always opened the sheet. */
let mockPathname = '/';

jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

jest.mock('@/features/voice/useQuickActions', () => ({
  useQuickActionRouting: () => {},
}));

// `items` is the receipt list and a real outcome always carries one, so the
// stub does too — leaving it off tests a shape the app never produces.
type Outcome = {
  items: unknown[];
  notice?: string;
  noticeAction?: { label: string; href: string };
};

const mockState: Record<string, unknown> = {};

jest.mock('@/features/voice/store', () => ({
  useVoiceStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockState),
}));

function setStore(outcome: Outcome | undefined, overrides: Record<string, unknown> = {}): void {
  for (const key of Object.keys(mockState)) delete mockState[key];
  Object.assign(mockState, {
    status: 'idle',
    expanded: true,
    // Typing moved into the store so the home mic can ask for the text box from
    // outside the sheet; the notice path never touches it.
    typing: false,
    setTyping: jest.fn(),
    startTyping: jest.fn(),
    partial: '',
    transcript: '',
    error: null,
    needsRetry: false,
    sttUnavailable: false,
    heardNothing: false,
    outcome,
    pendingClarification: null,
    // The transcript-keeping half of the store. Present here because a stub
    // that is missing an action does not fail as a missing action — it fails
    // as `undefined is not a function` inside an unrelated effect.
    recovered: null,
    draftSeed: null,
    recoverTranscript: jest.fn(),
    discardRecovered: jest.fn(),
    keepDraft: jest.fn(),
    consumeDraftSeed: jest.fn(),
    startListening: jest.fn(),
    stopListening: jest.fn(),
    submitText: jest.fn(),
    cancel: jest.fn(),
    close: jest.fn(),
    retry: jest.fn(),
    ...overrides,
  });
}

async function mount(): Promise<void> {
  // `require`, not a dynamic import: this project's jest runs without
  // --experimental-vm-modules, so `import()` throws at runtime rather than
  // resolving. jest.mock is hoisted above it either way.
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

describe('the cap notice on the home screen', () => {
  beforeEach(() => {
    mockPathname = '/';
  });

  it('opens the sheet and says what happened', async () => {
    setStore({
      items: [],
      notice: "You've used your free assistant requests.",
      noticeAction: { label: 'See plans', href: '/plans' },
    });
    await mount();

    expect(screen.getByText(/free assistant requests/i)).toBeTruthy();
  });

  /* A notice about money with nothing to press is how a person concludes the
     app is broken rather than that they need to buy something. */
  it('offers the one thing that fixes it', async () => {
    setStore({
      items: [],
      notice: "You've used your free assistant requests.",
      noticeAction: { label: 'See plans', href: '/plans' },
    });
    await mount();

    expect(screen.getByText('See plans')).toBeTruthy();
  });

  /* The other half of the rule, and the reason the sheet is conditional at all:
     home IS the voice interface, so a scrim over it on an ordinary turn hides
     the field, the ring and the receipt — the whole thing the app is for. */
  it('stays out of the way when there is nothing to say', async () => {
    setStore(undefined);
    await mount();

    expect(screen.queryByText(/assistant requests/i)).toBeNull();
  });
});
