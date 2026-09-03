/**
 * The month face.
 *
 * The model is covered in `grid.test.ts`; what is left here is the part a pure
 * function cannot assert — that a day reaches the screen at all, that tapping
 * one hands it back, and that a cell shows its load rather than a dot you have
 * to tap to decode.
 *
 * It covered the week grid too, until the Week view was removed: three views
 * were three answers to "what does my time look like" and the middle one was
 * the least distinct.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';

import { freezeClock } from '@/core/clock';
import { localToEpoch, type LocalDate } from '@/core/time';
import type { CalendarEvent, CurriculumEntry } from '@/db/schema';
import { ThemeProvider } from '@/ui/ThemeProvider';

import { buildAgenda, classesOnDate } from '../agenda';
import { monthGrid } from '../dates';
import { MonthGrid } from '../MonthGrid';

const ZONE = 'Europe/Sofia';
const TUE = '2026-08-11' as LocalDate;

function at(date: string, time: string): number {
  return localToEpoch(`${date}T${time}`, ZONE);
}

function event(overrides: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    title: 'Something',
    description: null,
    location: null,
    startsAt: at(TUE, '09:00'),
    endsAt: at(TUE, '10:00'),
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

function entry(overrides: Partial<CurriculumEntry> & { id: string }): CurriculumEntry {
  return {
    subjectName: 'Maths',
    teacher: null,
    location: null,
    dayOfWeek: 2,
    startTime: '11:00',
    endTime: '12:00',
    weekParity: 'every',
    color: null,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

let restoreClock = () => {};
beforeEach(() => {
  restoreClock = freezeClock(at(TUE, '10:30'));
});
afterEach(() => restoreClock());

const wrap = (ui: React.ReactElement) =>
  render(<ThemeProvider forceScheme="dark">{ui}</ThemeProvider>);

describe('MonthGrid', () => {
  const CELLS = monthGrid(at(TUE, '00:00'), ZONE, 1);

  /**
   * The cell draws bars, so the *label* is the only thing that names the day.
   * A coloured bar with no accessible name is the whole day invisible to a
   * screen reader, which is the failure this asserts against.
   */
  it('names the day to a screen reader even though it draws bars', async () => {
    await wrap(
      <MonthGrid
        cells={CELLS}
        anchor={at(TUE, '00:00')}
        items={buildAgenda([event({ id: 'a', title: 'Dentist' })], [])}
        zone={ZONE}
        weekStartsOn={1}
        selected={TUE}
        onSelectDate={jest.fn()}
      />,
    );
    // The label carries the load for a screen reader whether or not the cell
    // has measured itself yet.
    expect(screen.getByLabelText('11, 1 thing: 09:00 Dentist')).toBeTruthy();
    expect(screen.getByLabelText('12, nothing on')).toBeTruthy();
    // And it is bars: no title is drawn as text at this cell size.
    expect(screen.queryByText('Dentist')).toBeNull();
  });

  /**
   * The only thing that makes a month cell worth tapping. A grid you can look
   * at but not enter is a picture of a calendar.
   */
  it('hands the day back when a cell is tapped', async () => {
    const onSelectDate = jest.fn();
    await wrap(
      <MonthGrid
        cells={CELLS}
        anchor={at(TUE, '00:00')}
        items={[]}
        zone={ZONE}
        weekStartsOn={1}
        selected={TUE}
        onSelectDate={onSelectDate}
      />,
    );
    fireEvent.press(screen.getByLabelText('12, nothing on'));
    expect(onSelectDate).toHaveBeenCalledWith('2026-08-12');
  });

  it('draws the days either side of the month rather than blanking them', async () => {
    await wrap(
      <MonthGrid
        cells={CELLS}
        anchor={at(TUE, '00:00')}
        items={[]}
        zone={ZONE}
        weekStartsOn={1}
        selected={TUE}
        onSelectDate={jest.fn()}
      />,
    );
    // August 2026 starts on a Saturday, so the grid opens on Monday 27 July and
    // closes in September. Day 27 therefore appears **twice** — once greyed at
    // the top and once in the month proper — and that is the assertion: a grid
    // that blanked its edges would find one.
    expect(screen.getAllByLabelText('27, nothing on')).toHaveLength(2);
  });
});
