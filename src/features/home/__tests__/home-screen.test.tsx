import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { DateTime, dayRange } from '@/core/time';
import { ThemeProvider } from '@/ui/ThemeProvider';
import { ToastProvider } from '@/ui/components';
import { useVoiceStore } from '@/features/voice/store';

import HomeScreen from '../../../../app/index';

/* Reanimated's own mock still loads the native worklets module. The stub has to
   cover everything `@/ui/motion` and the heat field reach for, including
   `ReduceMotion` — the spring configs read it at module scope, so a missing key
   fails the whole suite at import rather than at render. */
jest.mock('react-native-reanimated', () => {
  const { View, Text } = jest.requireActual('react-native');
  const builder: Record<string, unknown> = {};
  builder.duration = () => builder;
  builder.delay = () => builder;
  const passthrough = (v: unknown) => v;
  return {
    __esModule: true,
    default: { View, Text, createAnimatedComponent: (c: unknown) => c },
    createAnimatedComponent: (c: unknown) => c,
    View,
    FadeIn: builder,
    FadeOut: builder,
    FadeInUp: builder,
    FadeOutUp: builder,
    LinearTransition: builder,
    ReduceMotion: { System: 'system', Always: 'always', Never: 'never' },
    Easing: {
      in: () => undefined,
      out: () => undefined,
      inOut: () => undefined,
      linear: undefined,
      quad: undefined,
      cubic: undefined,
      sin: undefined,
    },
    useSharedValue: (v: number) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
    useReducedMotion: () => false,
    withRepeat: passthrough,
    withSequence: passthrough,
    withSpring: passthrough,
    withTiming: passthrough,
    cancelAnimation: () => {},
  };
});

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
}));

jest.mock('@/hooks', () => ({ useToday: jest.fn() }));

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
  // Cleared, not reset: a reset would strip the async implementation and the
  // component's `.then()` would be reading it off undefined.
  mockUndoRun.mockClear();
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

  it('opens the menu and the profile from the corners', async () => {
    await wrap();

    await fireEvent.press(screen.getByTestId('home-menu'));
    expect(mockPush).toHaveBeenCalledWith('/menu');

    await fireEvent.press(screen.getByTestId('home-profile'));
    expect(mockPush).toHaveBeenCalledWith('/settings');
  });
});
