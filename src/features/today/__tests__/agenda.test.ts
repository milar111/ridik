import { buildAgenda, isAgendaEmpty } from '../agenda';
import type { CalendarEvent } from '@/db/schema';
import type { ClassOccurrence } from '@/repositories/curriculum';

const ZONE = 'Europe/Sofia';
const DAY_START = Date.UTC(2026, 7, 11, 21, 0); // 2026-08-12 00:00 in Sofia
const DAY_END = DAY_START + 24 * 3_600_000;
const hour = (h: number, m = 0): number => DAY_START + h * 3_600_000 + m * 60_000;

function event(over: Partial<CalendarEvent> & { id: string; startsAt: number }): CalendarEvent {
  return {
    title: 'Event',
    description: null,
    location: null,
    endsAt: over.startsAt + 3_600_000,
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
    ...over,
  } as CalendarEvent;
}

function occurrence(
  subjectName: string,
  startsAt: number,
  over: { id?: string; color?: string | null; location?: string | null } = {},
): ClassOccurrence {
  return {
    entry: {
      id: over.id ?? `c-${subjectName}`,
      subjectName,
      dayOfWeek: 3,
      startTime: '08:00',
      endTime: '09:00',
      location: over.location ?? null,
      weekParity: 'every',
      teacher: null,
      color: over.color ?? null,
      isActive: true,
      createdAt: 0,
      updatedAt: 0,
    },
    startsAt,
    endsAt: startsAt + 45 * 60_000,
  } as ClassOccurrence;
}

const build = (
  events: CalendarEvent[],
  classes: ClassOccurrence[],
  now: number,
): ReturnType<typeof buildAgenda> =>
  buildAgenda({ events, classes, window: { start: DAY_START, end: DAY_END }, now });

describe('buildAgenda', () => {
  it('merges events and classes into one time-ordered list', () => {
    const agenda = build(
      [event({ id: 'e1', title: 'Standup', startsAt: hour(9) })],
      [occurrence('Physics', hour(8)), occurrence('Maths', hour(11))],
      hour(7),
    );

    expect(agenda.timed.map((i) => i.title)).toEqual(['Physics', 'Standup', 'Maths']);
    expect(agenda.timed.map((i) => i.kind)).toEqual(['class', 'event', 'class']);
    expect(isAgendaEmpty(agenda)).toBe(false);
  });

  it('holds all-day events out of the timed list', () => {
    const agenda = build(
      [
        event({ id: 'e1', title: 'Public holiday', startsAt: DAY_START, allDay: true }),
        event({ id: 'e2', title: 'Standup', startsAt: hour(9) }),
      ],
      [],
      hour(7),
    );

    expect(agenda.allDay.map((i) => i.title)).toEqual(['Public holiday']);
    expect(agenda.timed.map((i) => i.title)).toEqual(['Standup']);
  });

  it('shows a class mirrored onto the calendar once', () => {
    const agenda = build(
      [event({ id: 'e1', title: 'physics', startsAt: hour(8), kind: 'class' })],
      [occurrence('Physics', hour(8))],
      hour(7),
    );

    expect(agenda.timed).toHaveLength(1);
    // The calendar row wins: it is the one with an id the rest of the app knows.
    expect(agenda.timed[0]?.kind).toBe('event');
  });

  it('keeps buffers as their own rows and names what they precede', () => {
    const agenda = build(
      [
        event({ id: 'e1', title: 'Dentist', startsAt: hour(10) }),
        event({
          id: 'b1',
          title: 'Travel',
          startsAt: hour(10),
          endsAt: hour(10),
          kind: 'buffer',
          bufferForId: 'e1',
        }),
      ],
      [],
      hour(7),
    );

    expect(agenda.timed.map((i) => i.kind)).toEqual(['buffer', 'event']);
    expect(agenda.timed[0]?.bufferFor).toBe('Dentist');
  });

  it('drops occurrences that roll forward past the day', () => {
    const agenda = build([], [occurrence('Chemistry', DAY_END + 3_600_000)], hour(7));
    expect(isAgendaEmpty(agenda)).toBe(true);
  });

  it('puts the now-rule between the rows either side of the clock', () => {
    const events = [
      event({ id: 'e1', title: 'Standup', startsAt: hour(9) }),
      event({ id: 'e2', title: 'Review', startsAt: hour(14) }),
      event({ id: 'e3', title: 'Gym', startsAt: hour(18) }),
    ];

    expect(build(events, [], hour(7)).nowIndex).toBe(0);
    expect(build(events, [], hour(12)).nowIndex).toBe(1);
    // Mid-event: the thing in progress belongs on the past side of the rule.
    expect(build(events, [], hour(14, 30)).nowIndex).toBe(2);
    expect(build(events, [], hour(23)).nowIndex).toBe(3);
  });

  it('carries a timetable colour through and leaves plain events uncoloured', () => {
    const agenda = build(
      [event({ id: 'e1', title: 'Standup', startsAt: hour(9) })],
      [occurrence('Physics', hour(8), { color: '#3FC1FF' })],
      hour(7),
    );

    expect(agenda.timed[0]?.color).toBe('#3FC1FF');
    expect(agenda.timed[1]?.color).toBeNull();
  });
});
