import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { DateTime, dayRange } from '@/core/time';
import { ThemeProvider } from '@/ui/ThemeProvider';
import { ToastProvider } from '@/ui/components';
import { registerVoicePipeline, useVoiceStore, type VoicePipeline } from '@/features/voice/store';

import HomeScreen from '../../../../app/index';

const mockPush = jest.fn();
const mockSetSetting = jest.fn();
const mockSetParams = jest.fn();
/** What the URL is carrying. `?speak=1` is how a widget asks for the mic. */
let mockParams: Record<string, string | string[]> = {};
let mockLastBriefingShown: string | null = '2026-08-11';
/**
 * Whether the first run has been answered. Home reads it to decide whether a
 * `?speak=1` may fire — `ConsentGate` draws its disclosure *over* this screen,
 * which stays mounted underneath. 'granted' by default so every other
 * assertion here is about an app somebody has already onboarded.
 */
let mockConsent: 'unset' | 'granted' | 'declined' = 'granted';
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    back: jest.fn(),
    replace: jest.fn(),
    navigate: jest.fn(),
    // The *global* setter, which writes to whichever route is focused. The
    // speak flag is read locally and must be cleared locally, so nothing here
    // may reach for this one.
    setParams: jest.fn(),
    canGoBack: () => true,
  }),
  // This route's own navigator: `useSpeakIntent` clears the flag through it.
  useNavigation: () => ({ setParams: mockSetParams }),
  useLocalSearchParams: () => mockParams,
  // `useNavigateOnce` releases its guard when the screen is focused again.
  useFocusEffect: (effect: () => void | (() => void)) => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(effect, [effect]);
  },
}));

jest.mock('@/hooks', () => ({
  useToday: jest.fn(),
  // Keyed, because home now reads two of them and they mean opposite things:
  // the briefing is presented once a day (marked already-seen by default so it
  // does not navigate out from under every other assertion), and the consent
  // answer is what a speak intent waits for.
  useSetting: (key: string) => ({
    value: key === 'assistantConsent' ? mockConsent : mockLastBriefingShown,
    isLoading: false,
    error: null,
    set: mockSetSetting,
  }),
}));

/* The undo goes through the same mutations the screens use, so the whole
   repository graph would come with them. What matters here is which one is
   offered, and that pressing it calls through. */
const mockUndoRun = jest.fn(async () => {});
jest.mock('@/hooks/useVoiceUndo', () => ({
  useVoiceUndo: () => ({ run: mockUndoRun, isPending: false }),
}));

/* The screen re-derives "next" from a ticking clock. Pinned, or the fixture day
   is always in the past and every assertion about it is about an empty list. */
jest.mock('@/features/today/useNow', () => ({ useNow: () => mockNow }));

/* `useDailyBriefing` compares today's local date against the last one seen. On
   the real clock every fixture day is "yesterday", so the briefing would open
   over the top of every test in this file. */
jest.mock('@/core/clock', () => ({ now: () => mockNow }));

const hooks = jest.requireMock('@/hooks') as { useToday: jest.Mock };

const ZONE = 'Europe/Sofia';
const NOW = DateTime.fromISO('2026-08-11T12:00', { zone: ZONE }).toMillis();
const mockNow = NOW;
const { start: DAY_START, end: DAY_END } = dayRange('2026-08-11', ZONE);
const at = (hhmm: string): number => DateTime.fromISO(`2026-08-11T${hhmm}`, { zone: ZONE }).toMillis();

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const snapshot = (over: Record<string, unknown> = {}): any => ({
  date: '2026-08-11',
  zone: ZONE,
  at: NOW,
  dayStart: DAY_START,
  dayEnd: DAY_END,
  events: [],
  classes: [],
  dueTasks: [],
  overdueTasks: [],
  habits: [],
  commitments: [],
  focus: null,
  sync: { pending: 0, inFlight: 0, failed: 0, badge: 0 },
  activity: [],
  ...over,
});

const event = (id: string, title: string, startsAt: number, over: Record<string, unknown> = {}): any => ({
  id,
  title,
  description: null,
  location: null,
  startsAt,
  endsAt: startsAt + 3_600_000,
  allDay: false,
  timezone: ZONE,
  kind: 'event',
  bufferForId: null,
  ...over,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">
        <QueryClientProvider client={client}>
          <ToastProvider>
            <HomeScreen />
          </ToastProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  mockPush.mockReset();
  mockSetParams.mockReset();
  mockParams = {};
  // Cleared, not reset: a reset would strip the async implementation and the
  // component's `.then()` would be reading it off undefined.
  mockUndoRun.mockClear();
  mockSetSetting.mockReset();
  mockLastBriefingShown = '2026-08-11';
  mockConsent = 'granted';
  useVoiceStore.getState().reset();
  hooks.useToday.mockReturnValue({ data: snapshot(), isPending: false, isError: false });
});

describe('home screen', () => {
  it('is a microphone and two corners, and nothing else to break', async () => {
    await wrap();

    expect(screen.getByTestId('home-mic')).toBeTruthy();
    expect(screen.getByTestId('home-menu')).toBeTruthy();
    expect(screen.getByTestId('home-profile')).toBeTruthy();
    expect(screen.getByText('TAP TO SPEAK')).toBeTruthy();
  });

  it('shows what is next and when to leave for it', async () => {
    hooks.useToday.mockReturnValue({
      data: snapshot({
        events: [
          event('m', 'Project meeting', at('15:00')),
          event('b', 'Travel / prep', at('14:40'), {
            kind: 'buffer',
            bufferForId: 'm',
            endsAt: at('15:00'),
          }),
        ],
      }),
      isPending: false,
      isError: false,
    });

    await wrap();

    expect(screen.getByText('Project meeting')).toBeTruthy();
    expect(screen.getByText('15:00')).toBeTruthy();
    expect(screen.getByText('leave 14:40')).toBeTruthy();
  });

  it('says so plainly when the day is done', async () => {
    hooks.useToday.mockReturnValue({
      data: snapshot({ events: [event('done', 'Standup', at('09:00'))] }),
      isPending: false,
      isError: false,
    });

    await wrap();
    expect(screen.getByText('Nothing left today')).toBeTruthy();
  });

  /* The reason the receipt exists: a voice-only screen where a mis-heard word
     lands silently is a screen that quietly corrupts your data. */
  it('shows what the last utterance did, and offers to take it back', async () => {
    await wrap();

    useVoiceStore.setState({
      outcome: {
        transcript: 'remind me to call Dad tomorrow',
        items: [
          { toolName: 'task_add', ok: true, summary: 'Task added: “call Dad”.', entityId: 'task-1' },
        ],
      },
    });

    expect(await screen.findByText('Task added: “call Dad”.')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('last-action-undo'));
    await waitFor(() =>
      expect(mockUndoRun).toHaveBeenCalledWith({
        kind: 'task',
        id: 'task-1',
        summary: 'Task added: “call Dad”.',
      }),
    );
  });

  it('offers no undo for a habit log, whose id is the habit itself', async () => {
    await wrap();

    useVoiceStore.setState({
      outcome: {
        transcript: 'log gym',
        items: [{ toolName: 'habit_log', ok: true, summary: 'Logged Gym.', entityId: 'habit-1' }],
      },
    });

    expect(await screen.findByText('Logged Gym.')).toBeTruthy();
    expect(screen.queryByTestId('last-action-undo')).toBeNull();
  });

  it('keeps the receipt out of the way until something has been said', async () => {
    await wrap();
    expect(screen.queryByTestId('last-action-undo')).toBeNull();
  });

  it('opens the menu from the corner', async () => {
    await wrap();
    await fireEvent.press(screen.getByTestId('home-menu'));
    expect(mockPush).toHaveBeenCalledWith('/menu');
  });

  it('opens the profile from the corner', async () => {
    await wrap();
    await fireEvent.press(screen.getByTestId('home-profile'));
    expect(mockPush).toHaveBeenCalledWith('/settings');
  });

  /* expo-router does not de-duplicate: two taps 80ms apart put two copies of
     Settings on the stack, and getting out took two presses of Back on what
     looked like one screen. */
  /* The briefing stopped being a notification you schedule and became something
     the app shows you once, the first time you open it that day. */
  it('shows the briefing on the first open of a new day, and records it', async () => {
    mockLastBriefingShown = '2026-08-10';

    await wrap();

    expect(mockPush).toHaveBeenCalledWith('/briefing');
    expect(mockSetSetting).toHaveBeenCalledWith('2026-08-11');
  });

  it('does not show it again later the same day', async () => {
    mockLastBriefingShown = '2026-08-11';
    await wrap();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('shows it on a first ever launch, when nothing has been recorded', async () => {
    mockLastBriefingShown = null;
    await wrap();
    expect(mockPush).toHaveBeenCalledWith('/briefing');
  });

  it('opens one Settings however fast you tap', async () => {
    await wrap();

    const profile = screen.getByTestId('home-profile');
    await fireEvent.press(profile);
    await fireEvent.press(profile);
    await fireEvent.press(profile);

    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  /* The reason any of this exists: five widgets and a launcher shortcut could
     only ever open a screen you read, and the thing they were all next to had
     no address at all. `?speak=1` is that address, and the whole difficulty is
     that a parameter is a value and not an event. */
  describe('the speak intent', () => {
    const listen = jest.fn(async () => {});
    const pipeline: VoicePipeline = {
      listen,
      stopListening: async () => {},
      process: async (transcript) => ({ transcript, items: [] }),
      speak: async () => {},
      stopSpeaking: async () => {},
    };

    beforeEach(() => {
      listen.mockClear();
      registerVoicePipeline(pipeline);
    });

    it('starts listening when a widget opens the app with ?speak=1', async () => {
      mockParams = { speak: '1' };
      await wrap();
      await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    });

    /* Cleared rather than remembered. Nothing else can distinguish "the URL
       still says speak" from "the user asked again", and coming Back from the
       menu onto a screen that never unmounted would otherwise re-fire. */
    it('takes the flag back out of the URL as it consumes it', async () => {
      mockParams = { speak: '1' };
      await wrap();
      await waitFor(() => expect(mockSetParams).toHaveBeenCalledWith({ speak: '' }));
    });

    it('fires once, however many times the screen re-renders', async () => {
      mockParams = { speak: '1' };
      await wrap();
      await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));

      // Home subscribes to the voice status, so a turn moving through the
      // pipeline is a real re-render with the URL unchanged — which is exactly
      // the sequence a listening session produces on its own.
      await act(async () => {
        useVoiceStore.setState({ status: 'thinking' });
        useVoiceStore.setState({ status: 'idle' });
      });
      await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    });

    it('leaves the mic alone on an ordinary launch', async () => {
      await wrap();
      expect(listen).not.toHaveBeenCalled();
      expect(mockSetParams).not.toHaveBeenCalled();
    });

    /**
     * The ordering between the two things that landed together, and the one a
     * reviewer will look for.
     *
     * `ConsentGate` is an overlay over the navigator rather than a redirect, so
     * this screen is mounted, routed and live *underneath* the disclosure. A
     * widget tap that fired anyway would open the microphone behind a screen
     * nobody has read yet — the one entry point in the app that is a verb
     * becoming the one way past the one screen that cannot be skipped.
     */
    it('does not open the microphone behind an unanswered consent screen', async () => {
      mockConsent = 'unset';
      mockParams = { speak: '1' };

      await wrap();
      await act(async () => {});

      expect(listen).not.toHaveBeenCalled();
      // And the tap is *held*, not spent: clearing the flag under the lid
      // would throw the intent away for having been early.
      expect(mockSetParams).not.toHaveBeenCalled();
    });

    it('honours that same tap the moment the question is answered', async () => {
      mockConsent = 'unset';
      mockParams = { speak: '1' };
      await wrap();
      expect(listen).not.toHaveBeenCalled();

      mockConsent = 'granted';
      // The answer lands through the settings cache, which re-renders home; the
      // voice status is this suite's way of provoking that same render. It has
      // to *change* — two writes back to the value it already held are batched
      // into no render at all, which is why the test above can use the pair.
      await act(async () => {
        useVoiceStore.setState({ status: 'thinking' });
      });

      await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    });

    /* Declining is an answer, and it leaves a working app: the offline matcher
       still files a plain sentence with nothing leaving the phone. Gating the
       mic on `granted` would have left the tile dead for ever on a rung that
       never needed the network. */
    it('still listens for somebody who declined the assistant', async () => {
      mockConsent = 'declined';
      mockParams = { speak: '1' };

      await wrap();

      await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    });
  });
});
