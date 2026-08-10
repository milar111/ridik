import { buildAgenda } from '@/features/today/agenda';
import { nextUp } from '../next';
import type { CalendarEvent } from '@/db/schema';

const DAY_START = 1_772_000_000_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

function event(over: Partial<CalendarEvent> & { id: string; title: string }): CalendarEvent {
  return {
    startsAt: DAY_START,
    endsAt: DAY_START + HOUR,
    allDay: false,
    kind: 'event',
    timezone: 'Europe/Sofia',
    location: null,
    description: null,
    bufferForId: null,
    projectId: null,
    taskId: null,
    googleEventId: null,
    googleCalendarId: null,
    nativeEventId: null,
    syncStatus: 'local_only',
    syncError: null,
    deletedAt: null,
    createdAt: DAY_START,
    updatedAt: DAY_START,
    ...over,
  } as CalendarEvent;
}

const agendaOf = (events: CalendarEvent[], now: number) =>
  buildAgenda({
    events,
    classes: [],
    window: { start: DAY_START, end: DAY_START + 24 * HOUR },
    now,
  });

describe('nextUp', () => {
  it('names the next thing and when to leave for it', () => {
    const meeting = event({
      id: 'm',
      title: 'Project meeting',
      startsAt: DAY_START + 5 * HOUR,
      endsAt: DAY_START + 6 * HOUR,
    });
    const buffer = event({
      id: 'b',
      title: 'Travel / prep',
      startsAt: DAY_START + 5 * HOUR - 20 * MINUTE,
      endsAt: DAY_START + 5 * HOUR,
      kind: 'buffer',
      bufferForId: 'm',
    });

    const next = nextUp(agendaOf([meeting, buffer], DAY_START), DAY_START);

    expect(next?.item.title).toBe('Project meeting');
    expect(next?.leaveAt).toBe(DAY_START + 5 * HOUR - 20 * MINUTE);
  });

  it('keeps naming the thing you are sitting in rather than the one after it', () => {
    // Halfway through a two-hour class. Telling the user the next thing is the
    // 4pm meeting — and to leave for it — while they are still in the lab is
    // how a glanceable line becomes a lie.
    const now = DAY_START + 3 * HOUR;
    const current = event({
      id: 'c',
      title: 'Robotics',
      startsAt: DAY_START + 2 * HOUR,
      endsAt: DAY_START + 4 * HOUR,
    });
    const later = event({
      id: 'l',
      title: 'Supervisor',
      startsAt: DAY_START + 6 * HOUR,
      endsAt: DAY_START + 7 * HOUR,
    });

    expect(nextUp(agendaOf([current, later], now), now)?.item.title).toBe('Robotics');
  });

  it('never offers a travel block as the thing itself', () => {
    const meeting = event({
      id: 'm',
      title: 'Dentist',
      startsAt: DAY_START + 2 * HOUR,
      endsAt: DAY_START + 3 * HOUR,
    });
    const buffer = event({
      id: 'b',
      title: 'Travel / prep',
      startsAt: DAY_START + 2 * HOUR - 20 * MINUTE,
      endsAt: DAY_START + 2 * HOUR,
      kind: 'buffer',
      bufferForId: 'm',
    });

    const next = nextUp(agendaOf([meeting, buffer], DAY_START), DAY_START);

    expect(next?.item.kind).not.toBe('buffer');
    expect(next?.item.title).toBe('Dentist');
  });

  it('reports nothing once the day is behind you', () => {
    const done = event({
      id: 'd',
      title: 'Standup',
      startsAt: DAY_START + HOUR,
      endsAt: DAY_START + 2 * HOUR,
    });

    expect(nextUp(agendaOf([done], DAY_START + 9 * HOUR), DAY_START + 9 * HOUR)).toBeNull();
  });

  it('does not let an all-day item pose as the next appointment', () => {
    // An all-day item has no hour to act on, so it would sit there as "next"
    // for the whole day while the 2pm it is hiding went unmentioned.
    const allDay = event({
      id: 'a',
      title: 'Deadline',
      allDay: true,
      startsAt: DAY_START,
      endsAt: DAY_START + 24 * HOUR,
    });
    const real = event({
      id: 'r',
      title: 'Lab',
      startsAt: DAY_START + 6 * HOUR,
      endsAt: DAY_START + 7 * HOUR,
    });

    expect(nextUp(agendaOf([allDay, real], DAY_START), DAY_START)?.item.title).toBe('Lab');
  });
});
