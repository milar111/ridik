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

const mockBack = jest.fn();
const mockSpeech = { isSpeaking: false, play: jest.fn(), stop: jest.fn() };
const mockSetTts = jest.fn();
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
  shareAsFile: jest.fn(),
}));

jest.mock('@/hooks', () => ({
  useSetting: () => ({
    value: mockTtsEnabled,
    isLoading: false,
    error: null,
    set: mockSetTts,
    isSaving: false,
  }),
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
    jest.clearAllMocks();
  });

  it('shows the three bullets and plays the script for the chosen scope', async () => {
    await wrap();
    expect(screen.getByText('Physics at 09:00, then 2 more.')).toBeTruthy();
    expect(screen.getByText('Lab report is overdue.')).toBeTruthy();
    expect(screen.getByText('Log Reading to keep your 6-day streak.')).toBeTruthy();

    await fireEvent.press(screen.getByText('Tomorrow'));
    await fireEvent.press(screen.getByText('Play'));
    expect(mockSpeech.play).toHaveBeenCalledWith('tomorrow');

    // Share opens the OS sheet, which copies too; two buttons for it is one.
    expect(screen.getByLabelText('Share the briefing')).toBeTruthy();
    expect(screen.queryByLabelText('Copy the briefing as markdown')).toBeNull();
  });

  /* Play is the answer to "shall I speak?". A dead button beside a link to
     another screen made the user go and say yes somewhere else first — but
     "Speak replies" governs speech nobody asked for, so one press here must
     not switch it back on for the whole app. */
  it('speaks when "Speak replies" is off, without switching it on', async () => {
    mockTtsEnabled = false;
    await wrap();

    const play = screen.getByLabelText('Play the spoken briefing');
    expect(play.props.accessibilityState).toMatchObject({ disabled: false });

    await fireEvent.press(play);
    expect(mockSpeech.play).toHaveBeenCalledWith('today');
    expect(mockSetTts).not.toHaveBeenCalled();
  });

  it('can always be dismissed', async () => {
    await wrap();
    await fireEvent.press(screen.getByLabelText('Close briefing'));
    expect(mockBack).toHaveBeenCalled();
  });
});
