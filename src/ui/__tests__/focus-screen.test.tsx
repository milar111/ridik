/**
 * Render smoke tests for the Focus screen.
 *
 * The data layer is mocked at the hook boundary: the screen's contract is
 * "given this snapshot, show this", and pulling in the real focus runtime would
 * drag notifications, audio and SQLite into a render test.
 */
import { render, screen, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '../ThemeProvider';
import FocusScreen from '../../../app/focus';
import type { FocusSnapshot, SessionPhase } from '@/hooks/useFocusRuntime';

// The component barrel pulls in the toast stack, which imports reanimated —
// and worklets have no native side under jest. The library's own mock loads the
// real module first, so this stands in for it: nothing here animates.
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const animation = { duration: () => animation };
  return {
    __esModule: true,
    default: { View, createAnimatedComponent: (component: unknown) => component },
    FadeInUp: animation,
    FadeOutUp: animation,
    LinearTransition: animation,
  };
});

const mockControl = { mutate: jest.fn(), isPending: false };
const mockStart = { mutate: jest.fn(), isPending: false };
let mockLive: { snapshot: FocusSnapshot | null; phases: SessionPhase[]; isLoading: boolean } = {
  snapshot: null,
  phases: [],
  isLoading: false,
};
let mockSummaries: unknown[] = [];

jest.mock('@/hooks', () => ({
  useFocusMinutes: () => ({ data: 125 }),
  useProjects: () => ({ data: [] }),
}));

jest.mock('@/hooks/useFocusRuntime', () => ({
  useLiveFocus: () => mockLive,
  useRecentFocusSummaries: () => ({
    summaries: mockSummaries,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useFocusControl: () => mockControl,
  useStartFocusPlan: () => mockStart,
  previewFocusPlan: () => [
    { kind: 'focus', minutes: 25 },
    { kind: 'break', minutes: 5 },
    { kind: 'focus', minutes: 25 },
  ],
  focusPlanTotals: () => ({ focusMinutes: 50, breakMinutes: 5, totalMinutes: 55 }),
}));

const RUNNING: FocusSnapshot = {
  sessionId: 's1',
  label: 'Maths revision',
  subject: 'Maths',
  status: 'running',
  phase: { kind: 'focus', minutes: 25 },
  phaseIndex: 0,
  phaseCount: 3,
  phaseElapsedMs: 5 * 60_000,
  phaseRemainingMs: 20 * 60_000,
  totalRemainingMs: 50 * 60_000,
  phaseEndsAt: null,
  isComplete: false,
  clock: '20:00',
  at: 0,
};

// Without metrics the provider renders nothing until a layout pass that never
// comes under jest, and every query silently returns empty.
const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function wrap() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">
        <FocusScreen />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

const FINISHED = {
  session: {
    id: 'f1',
    label: 'Maths revision',
    subject: 'Maths',
    projectId: null,
    startedAt: Date.UTC(2026, 0, 5, 9, 0),
    status: 'completed',
  },
  minutes: 50,
  phases: [
    { kind: 'focus', minutes: 25 },
    { kind: 'break', minutes: 5 },
    { kind: 'focus', minutes: 25 },
  ],
};

describe('focus screen', () => {
  beforeEach(() => {
    mockLive = { snapshot: null, phases: [], isLoading: false };
    mockSummaries = [];
    mockControl.mutate.mockClear();
    mockStart.mutate.mockClear();
  });

  it('teaches the voice path when nothing has ever run', async () => {
    await wrap();
    expect(screen.getByText('Pomodoro')).toBeTruthy();
    expect(screen.getByText(/2-hour study session/)).toBeTruthy();
    expect(screen.getByText('Focused this week')).toBeTruthy();
  });

  it('shows the countdown and pauses a running session', async () => {
    mockLive = {
      snapshot: RUNNING,
      phases: [
        { kind: 'focus', minutes: 25 },
        { kind: 'break', minutes: 5 },
        { kind: 'focus', minutes: 25 },
      ],
      isLoading: false,
    };
    await wrap();

    expect(screen.getByText('20:00')).toBeTruthy();
    expect(screen.getByText('FOCUS')).toBeTruthy();
    expect(screen.getByText('Phase 1 of 3')).toBeTruthy();
    // The idle builder must be gone; one session at a time.
    expect(screen.queryByText('Pomodoro')).toBeNull();

    await fireEvent.press(screen.getByText('Pause'));
    expect(mockControl.mutate).toHaveBeenCalledWith('pause', expect.anything());
  });

  /* Three numeric fields that had to agree with each other — and with a cycle
     cap the screen never showed — are a puzzle, not a control. The presets
     carry the subject; anything else is spoken. */
  it('starts a preset with the subject typed above it, and has no numeric builder', async () => {
    await wrap();

    expect(screen.queryByText('TOTAL MIN')).toBeNull();
    expect(screen.queryByText('FOCUS MIN')).toBeNull();
    expect(screen.queryByText('BREAK MIN')).toBeNull();
    expect(screen.queryByText('Start session')).toBeNull();

    await fireEvent.changeText(screen.getByPlaceholderText(/Math, thesis/), 'Physics');
    await fireEvent.press(screen.getByText('Pomodoro'));

    expect(mockStart.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Physics',
        subject: 'Physics',
        focusMinutes: 25,
        breakMinutes: 5,
        cycles: 4,
      }),
      expect.anything(),
    );
  });

  it('keeps history as a record, not a third way to start a session', async () => {
    mockSummaries = [FINISHED];
    await wrap();

    expect(screen.getByText('Maths revision')).toBeTruthy();
    expect(screen.queryByLabelText(/again$/)).toBeNull();

    await fireEvent.press(screen.getByText('Maths revision'));
    expect(mockStart.mutate).not.toHaveBeenCalled();
  });
});
