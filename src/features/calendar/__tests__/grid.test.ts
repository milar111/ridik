/**
 * The month grid, without a screen.
 *
 * What is left after the Week view was removed and took most of `grid.ts` with
 * it: the ordering a cell reads in. An out-of-office or a holiday frames the
 * day the timed things happen in, so it comes first however late it was added
 * — a renderer would hide that by drawing *something* rather than failing.
 */
import { localToEpoch, type LocalDate } from '@/core/time';
import type { CalendarEvent } from '@/db/schema';

import { buildAgenda } from '../agenda';
import { monthCell } from '../grid';

const ZONE = 'Europe/Sofia';
const TUE = '2026-08-11' as LocalDate;
const WED = '2026-08-12' as LocalDate;

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

const build = (events: CalendarEvent[]) => buildAgenda(events, []);

describe('a month cell', () => {
  it('reads all-day first, then by start', () => {
    const items = build([
      event({ id: 'late', startsAt: at(TUE, '15:00'), endsAt: at(TUE, '16:00') }),
      event({ id: 'holiday', allDay: true }),
      event({ id: 'early', startsAt: at(TUE, '09:00'), endsAt: at(TUE, '10:00') }),
    ]);
    expect(monthCell(items, TUE, ZONE).map((i) => i.key)).toEqual(['holiday', 'early', 'late']);
  });
});
