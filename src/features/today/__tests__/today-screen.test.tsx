import { render, screen, fireEvent } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { DateTime, dayRange } from '@/core/time';
import { ThemeProvider } from '@/ui/ThemeProvider';
import { ToastProvider } from '@/ui/components';

import TodayScreen from '../../../../app/today';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
}));

// Both of these bind native stacks (speech, notifications, Live Activity) that
// this screen only ever reads through. Stubbing the hooks keeps the whole
// service graph out of the test.
jest.mock('@/hooks/useBriefing', () => ({
  useBriefing: () => ({
    data: {
      bullets: [
        { icon: 'calendar', text: 'Standup at 09:00.' },
        { icon: 'overdue', text: 'Order hinges is overdue.' },
        { icon: 'streak', text: '4-day Gym streak going strong.' },
      ],
    },
    isError: false,
    refetch: jest.fn(),
  }),
  useBriefingSpeech: () => ({ isSpeaking: false, play: jest.fn(), stop: jest.fn() }),
}));

jest.mock('@/hooks/useFocusRuntime', () => ({
  useLiveFocus: () => ({ snapshot: null, phases: [], isLoading: false }),
  useFocusControl: () => ({ mutate: jest.fn() }),
}));

jest.mock('@/hooks', () => ({
  qk: { today: { all: ['today'] }, briefing: { all: ['briefing'] }, sync: { all: ['sync'] } },
  invalidateKeys: jest.fn(async () => {}),
  useToday: jest.fn(),
  useCompleteTask: jest.fn(),
  useLogHabit: jest.fn(),
}));

const hooks = jest.requireMock('@/hooks') as {
  useToday: jest.Mock;
  useCompleteTask: jest.Mock;
  useLogHabit: jest.Mock;
};

const ZONE = 'Europe/Sofia';
const NOW = DateTime.fromISO('2026-08-11T12:00', { zone: ZONE }).toMillis();
const { start: DAY_START, end: DAY_END } = dayRange('2026-08-11', ZONE);
const at = (hhmm: string): number => DateTime.fromISO(`2026-08-11T${hhmm}`, { zone: ZONE }).toMillis();

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function snapshot(over: Record<string, unknown> = {}): any {
  return {
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
  };
}

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

const commitment = (
  id: string,
  who: string,
  text: string,
  over: Record<string, unknown> = {},
): any => ({
  commitment: {
    id,
    entityId: `p-${who}`,
    commitmentText: text,
    dueDate: null,
    isCompleted: false,
    createdAt: 0,
    direction: 'i_owe',
    taskId: null,
    completedAt: null,
    ...over,
  },
  entity: { id: `p-${who}`, name: who, kind: 'person', createdAt: 0, updatedAt: 0 },
});

const task = (id: string, title: string, dueDate: number | null): any => ({
  id,
  title,
  dueDate,
  isCompleted: false,
  isLocked: false,
  notes: null,
  priority: 2,
  projectId: null,
  estimatedMinutes: null,
  completedAt: null,
  unlockedAt: null,
  calendarEventId: null,
  source: 'voice',
  createdAt: 0,
  updatedAt: 0,
});
 

function setToday(data: unknown, over: Record<string, unknown> = {}) {
  hooks.useToday.mockReturnValue({
    data,
    isPending: data === undefined,
    isError: false,
    refetch: jest.fn(),
    ...over,
  });
}

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">
        <QueryClientProvider client={client}>
          <ToastProvider>
            <TodayScreen />
          </ToastProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  hooks.useCompleteTask.mockReturnValue({ mutate: jest.fn() });
  hooks.useLogHabit.mockReturnValue({ mutate: jest.fn() });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('Today screen', () => {
  it('shows a skeleton on the very first read and nothing else', async () => {
    setToday(undefined);
    await wrap();
    expect(screen.getByLabelText('Loading your day')).toBeTruthy();
    expect(screen.queryByText('Nothing on today')).toBeNull();
  });

  it('teaches the voice path when the whole day is empty', async () => {
    setToday(snapshot());
    await wrap();
    expect(screen.getByText('Nothing on today')).toBeTruthy();
    expect(screen.getByText(/remind me to call the dentist/)).toBeTruthy();
  });

  it('merges events and classes and rules off where now falls', async () => {
    setToday(
      snapshot({
        events: [
          event('e1', 'Standup', at('09:00')),
          event('e2', 'Dentist', at('15:00')),
          event('b1', 'Travel', at('14:40'), {
            endsAt: at('15:00'),
            kind: 'buffer',
            bufferForId: 'e2',
          }),
        ],
      }),
    );
    await wrap();

    expect(screen.getByText('Standup')).toBeTruthy();
    expect(screen.getByText('09:00')).toBeTruthy();
    // The auto-inserted block reads as scaffolding, and says what it is for.
    expect(screen.getByText('Travel / prep')).toBeTruthy();
    // Twice: the appointment itself, and the buffer naming what it is for.
    expect(screen.getAllByText('Dentist')).toHaveLength(2);
    expect(screen.getByLabelText('Now')).toBeTruthy();
  });

  it('marks an overdue task in days and completes one in a tap', async () => {
    const mutate = jest.fn((_id: string, options: { onSuccess: (r: unknown) => void }) => {
      options.onSuccess({ task: task('t1', 'Order hinges', null), unlocked: [task('t2', 'Sand the frame', null)] });
    });
    hooks.useCompleteTask.mockReturnValue({ mutate });

    setToday(
      snapshot({
        overdueTasks: [task('t1', 'Order hinges', at('09:00') - 2 * 86_400_000)],
        dueTasks: [task('t3', 'Ring the glazier', at('17:30'))],
      }),
    );
    await wrap();

    expect(screen.getByText('2 days late')).toBeTruthy();
    expect(screen.getByText('17:30')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('due-t1'));
    expect(mutate).toHaveBeenCalledWith('t1', expect.anything());
    // Spec 5.4: the chain is invisible until this moment, so it announces itself.
    expect(screen.getByText('Unlocked next step: Sand the frame')).toBeTruthy();
  });

  it('logs a habit from the strip and reports the new streak', async () => {
    const mutate = jest.fn(
      (_input: unknown, options: { onSuccess: (r: unknown) => void }) => options.onSuccess({ streak: 5 }),
    );
    hooks.useLogHabit.mockReturnValue({ mutate });

    setToday(
      snapshot({
        habits: [
          {
            habit: { id: 'h1', name: 'Gym', lastCompletedDate: '2026-08-10', currentStreak: 4 },
            loggedToday: false,
            streak: 4,
          },
        ],
      }),
    );
    await wrap();

    // Logged yesterday and not today: the run ends tonight unless it is tapped.
    const chip = screen.getByLabelText('Log Gym, streak at risk');
    await fireEvent.press(chip);
    expect(mutate).toHaveBeenCalledWith({ habitName: 'Gym' }, expect.anything());
    expect(screen.getByText('5-day streak')).toBeTruthy();
  });

  it('badges the outbox only while something is waiting', async () => {
    setToday(snapshot({ sync: { pending: 2, inFlight: 1, failed: 0, badge: 3 } }));
    const first = await wrap();
    expect(screen.getByText('Syncing 3')).toBeTruthy();
    await first.unmount();

    setToday(snapshot());
    await wrap();
    expect(screen.queryByText(/Syncing/)).toBeNull();
    expect(screen.queryByTestId('today-sync-badge')).toBeNull();
  });

  it('calls a failed write a failure rather than leaving it "syncing"', async () => {
    setToday(snapshot({ sync: { pending: 0, inFlight: 0, failed: 2, badge: 2 } }));
    await wrap();

    expect(screen.queryByText(/Syncing/)).toBeNull();
    expect(screen.getByText('2 failures')).toBeTruthy();
    // Waiting is a state the user can act on, so the badge has to lead somewhere.
    expect(screen.getByTestId('today-sync-badge')).toBeTruthy();
  });

  it('names both directions of a commitment and who it is with', async () => {
    setToday(
      snapshot({
        commitments: [
          commitment('c1', 'Ivo', 'send the invoice', { dueDate: at('09:00') }),
          commitment('c2', 'Mira', 'the drill bits', { direction: 'they_owe' }),
        ],
      }),
    );
    await wrap();

    expect(screen.getByText('send the invoice')).toBeTruthy();
    expect(screen.getByText(/You owe Ivo/)).toBeTruthy();
    expect(screen.getByText(/Mira owes you/)).toBeTruthy();
    // Due at 09:00 and it is midday: the promise has run out of time.
    expect(screen.getByText('Overdue')).toBeTruthy();
  });

  it('offers a retry instead of an empty day when the read fails', async () => {
    setToday(undefined, { isPending: false, isError: true });
    await wrap();

    expect(screen.getByTestId('today-error')).toBeTruthy();
    expect(screen.queryByText('Nothing on today')).toBeNull();
    expect(screen.queryByLabelText('Loading your day')).toBeNull();
  });

  /*
   * A refetch that fails over a cached snapshot used to be completely silent:
   * the day stayed on screen, looking exactly like a current one, and nothing
   * said it had stopped updating. That is the failure this screen cannot have,
   * because the user goes on trusting what they can see.
   */
  it('says the day has stopped updating when a refetch fails over it', async () => {
    const refetch = jest.fn();
    setToday(snapshot({ events: [event('e1', 'Standup', at('09:00'))] }), {
      isPending: false,
      isError: true,
      refetch,
    });
    await wrap();

    // The day is still there. It is not replaced by an error, and it is not
    // hidden — it is still probably right.
    expect(screen.getByText('Standup')).toBeTruthy();
    expect(screen.queryByTestId('today-error')).toBeNull();

    // And the timestamp is the point: "as it was at 12:00" is what turns a day
    // that looks fine into one the user can see is an hour old.
    expect(screen.getByTestId('today-stale')).toBeTruthy();
    expect(screen.getByText(/as it was at 12:00/)).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Refresh' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('says nothing about staleness while the day is fresh', async () => {
    setToday(snapshot({ events: [event('e1', 'Standup', at('09:00'))] }));
    await wrap();

    expect(screen.queryByTestId('today-stale')).toBeNull();
  });
});
