import { render, screen } from '@testing-library/react-native';

import { freezeClock } from '@/core/clock';
import { localToEpoch } from '@/core/time';
import type { CalendarEvent } from '@/db/schema';
import { useCalendarDay, useCurriculumDay } from '@/hooks';
import { ThemeProvider } from '@/ui/ThemeProvider';

import { AgendaList } from '../AgendaList';

jest.mock('@/hooks', () => ({
  useCalendarDay: jest.fn(),
  useCurriculumDay: jest.fn(),
}));

// The component barrel re-exports the toast stack, whose reanimated import
// cannot initialise its native worklets module under jest-expo.
jest.mock('@/ui/components/Toast', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
  useToast: () => ({ show: jest.fn(), dismiss: jest.fn() }),
}));

const ZONE = 'Europe/Sofia';
const DATE = '2026-08-11';

const dayQuery = useCalendarDay as unknown as jest.Mock;
const classQuery = useCurriculumDay as unknown as jest.Mock;

function at(time: string): number {
  return localToEpoch(`${DATE}T${time}`, ZONE);
}

function event(overrides: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    title: 'Something',
    description: null,
    location: null,
    startsAt: at('09:00'),
    endsAt: at('10:00'),
    allDay: false,
    timezone: ZONE,
    kind: 'event',
    bufferForId: null,
    projectId: null,
    taskId: null,
    googleEventId: null,
    googleCalendarId: null,
    nativeEventId: null,
    syncStatus: 'synced',
    syncError: null,
    deletedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function stub(events: CalendarEvent[], extra: Record<string, unknown> = {}) {
  dayQuery.mockReturnValue({
    data: events,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
    ...extra,
  });
  classQuery.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: jest.fn() });
}

let restoreClock = () => {};

beforeEach(() => {
  restoreClock = freezeClock(at('08:00'));
});

afterEach(() => restoreClock());

// RNTL 14 renders asynchronously; every render must be awaited.
function wrap(ui: React.ReactElement) {
  return render(<ThemeProvider forceScheme="dark">{ui}</ThemeProvider>);
}

describe('AgendaList', () => {
  it('renders a buffer attached to the event it belongs to', async () => {
    stub([
      event({ id: 'e1', title: 'Dentist', location: 'Main St 12', startsAt: at('09:00'), endsAt: at('09:30') }),
      event({
        id: 'b1',
        title: 'Leave for Dentist',
        kind: 'buffer',
        bufferForId: 'e1',
        startsAt: at('08:40'),
        endsAt: at('09:00'),
      }),
    ]);

    await wrap(<AgendaList date={DATE} zone={ZONE} onOpen={jest.fn()} />);

    expect(screen.getByText('Dentist')).toBeTruthy();
    expect(screen.getByText('Leave for Dentist')).toBeTruthy();
    expect(screen.getByText('Main St 12')).toBeTruthy();
    // Both rows carry their own gutter time.
    expect(screen.getByText('08:40')).toBeTruthy();
    expect(screen.getByText('09:00')).toBeTruthy();
    expect(screen.getByText('1 event')).toBeTruthy();
  });

  it('coaches the user with something to say when the day is empty', async () => {
    stub([]);
    await wrap(<AgendaList date={DATE} zone={ZONE} onOpen={jest.fn()} />);
    expect(screen.getByText('Nothing on this day')).toBeTruthy();
    expect(screen.getByText(/dentist Tuesday at 3/)).toBeTruthy();
  });

  it('offers a retry instead of crashing when the day fails to load', async () => {
    stub([], { isError: true });
    await wrap(<AgendaList date={DATE} zone={ZONE} onOpen={jest.fn()} />);
    expect(screen.getByText('This day would not load.')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
  });
});
