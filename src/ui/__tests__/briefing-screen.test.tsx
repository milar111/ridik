/**
 * Render smoke tests for the Briefing modal.
 *
 * Mocked at the hook boundary: composing a real briefing needs seven
 * repositories, and what this screen owes the user is the three bullets, a way
 * to hear them and a way out.
 */
import { render, screen, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '../ThemeProvider';
import BriefingScreen from '../../../app/briefing';
import type { Briefing } from '@/hooks/useBriefing';

// See focus-screen.test.tsx: the component barrel imports reanimated, whose own
// mock loads the real (native-only) module first.
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

const mockBack = jest.fn();
const mockSpeech = { isSpeaking: false, play: jest.fn(), stop: jest.fn() };
let mockTtsEnabled = true;

jest.mock('expo-router', () => ({
  useRouter: () => ({
    back: mockBack,
    push: jest.fn(),
    replace: jest.fn(),
    canGoBack: () => true,
  }),
}));

jest.mock('@/features/export', () => ({
  briefingMarkdown: () => '# Briefing',
  copyToClipboard: jest.fn(),
  shareAsFile: jest.fn(),
}));

jest.mock('@/hooks', () => ({
  useSetting: () => ({ value: mockTtsEnabled, isLoading: false, error: null, set: jest.fn(), isSaving: false }),
}));

jest.mock('@/hooks/useBriefing', () => ({
  useBriefing: () => ({ data: mockBriefing, isError: false, error: null, refetch: jest.fn() }),
  useBriefingSpeech: () => mockSpeech,
}));

const mockBriefing: Briefing = {
  bullets: [
    { icon: 'calendar', text: 'Physics at 09:00, then 2 more.' },
    { icon: 'overdue', text: 'Lab report is overdue.' },
    { icon: 'streak', text: 'Log Reading to keep your 6-day streak.' },
  ],
  spoken: 'Good morning.',
  data: {
    scope: 'today',
    now: 1_700_000_000_000,
    zone: 'Europe/Sofia',
    date: '2023-11-14',
    window: { start: 0, end: 1 },
    events: [],
    classes: [],
    overdueTasks: [],
    dueTasks: [],
    upcomingTasks: [],
    unlockedTasks: [],
    streaks: [],
    streaksAtRisk: [],
    commitments: [],
    focus: null,
    unsyncedCount: 0,
  },
};

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function wrap() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">
        <BriefingScreen />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

describe('briefing screen', () => {
  beforeEach(() => {
    mockTtsEnabled = true;
  });

  it('shows the three bullets and plays the script for the chosen scope', async () => {
    await wrap();
    expect(screen.getByText('Physics at 09:00, then 2 more.')).toBeTruthy();
    expect(screen.getByText('Lab report is overdue.')).toBeTruthy();
    expect(screen.getByText('Log Reading to keep your 6-day streak.')).toBeTruthy();

    await fireEvent.press(screen.getByText('Tomorrow'));
    await fireEvent.press(screen.getByText('Play'));
    expect(mockSpeech.play).toHaveBeenCalledWith('tomorrow');
  });

  it('refuses to speak while speech is switched off, and can always be dismissed', async () => {
    mockTtsEnabled = false;
    await wrap();

    expect(screen.getByText('Speech is off · Settings')).toBeTruthy();
    expect(screen.getByLabelText('Play the spoken briefing').props.accessibilityState).toMatchObject(
      { disabled: true },
    );

    await fireEvent.press(screen.getByLabelText('Close briefing'));
    expect(mockBack).toHaveBeenCalled();
  });
});
