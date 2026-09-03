import { epochToLocal, localToEpoch } from '@/core/time';
import type { CalendarEvent, CurriculumEntry } from '@/db/schema';

import {
  buildAgenda,
  classesOnDate,
  countByDate,
  densityDots,
  describeSync,
  durationMinutes,
  joinsOf,
} from '../agenda';
import {
  formatMonthLabel,
  monthGrid,
  startOfWeek,
  weekDates,
  weekdayIndexOf,
  weeksBetween,
} from '../dates';

const ZONE = 'Europe/Sofia';
const DATE = '2026-08-11'; // A Tuesday.

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
    syncStatus: 'pending',
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
    dayOfWeek: 2, // Tuesday, in the schema's 0=Sunday numbering.
    startTime: '08:00',
    endTime: '08:45',
    location: null,
    weekParity: 'every',
    teacher: null,
    color: null,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('buildAgenda', () => {
  it('hangs a buffer off its event instead of listing it separately', () => {
    const dentist = event({ id: 'e1', title: 'Dentist', startsAt: at('09:00'), endsAt: at('09:30') });
    const travel = event({
      id: 'b1',
      title: 'Leave for Dentist',
      kind: 'buffer',
      bufferForId: 'e1',
      startsAt: at('08:40'),
      endsAt: at('09:00'),
    });

    const items = buildAgenda([travel, dentist], []);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'event', key: 'e1' });
    expect(items[0]!.type === 'event' && items[0]!.buffer?.id).toBe('b1');
  });

  it('keeps an orphaned buffer visible as a row of its own', () => {
    const orphan = event({
      id: 'b1',
      kind: 'buffer',
      bufferForId: 'gone',
      startsAt: at('08:40'),
      endsAt: at('09:00'),
    });

    const items = buildAgenda([orphan], []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'event', key: 'b1' });
    expect(items[0]!.type === 'event' && items[0]!.buffer).toBeNull();
  });

  it('attaches only the earliest of two buffers and lists the rest', () => {
    const parent = event({ id: 'e1', startsAt: at('12:00'), endsAt: at('13:00') });
    const early = event({ id: 'b1', kind: 'buffer', bufferForId: 'e1', startsAt: at('11:30'), endsAt: at('12:00') });
    const late = event({ id: 'b2', kind: 'buffer', bufferForId: 'e1', startsAt: at('11:45'), endsAt: at('12:00') });

    const items = buildAgenda([parent, late, early], []);

    // The kept buffer pulls its event up to 11:30, ahead of the leftover row.
    expect(items.map((i) => i.key)).toEqual(['e1', 'b2']);
    expect(items[0]!.type === 'event' && items[0]!.buffer?.id).toBe('b1');
  });

  it('orders all-day first, then by where the row visually starts', () => {
    const allDay = event({ id: 'a', title: 'Holiday', allDay: true, startsAt: at('00:00'), endsAt: at('23:59') });
    const late = event({ id: 'e2', title: 'Standup', startsAt: at('09:15'), endsAt: at('09:30') });
    const buffered = event({ id: 'e1', title: 'Dentist', startsAt: at('09:20'), endsAt: at('09:50') });
    const travel = event({ id: 'b1', kind: 'buffer', bufferForId: 'e1', startsAt: at('09:00'), endsAt: at('09:20') });
    const lesson = classesOnDate([entry({ id: 'c1' })], DATE, ZONE);

    const items = buildAgenda([late, buffered, travel, allDay], lesson);

    // The dentist sorts before the standup because its travel block starts first.
    expect(items.map((i) => i.key)).toEqual(['a', `class:c1:${at('08:00')}`, 'e1', 'e2']);
  });

  it('drops soft-deleted rows', () => {
    const items = buildAgenda([event({ id: 'e1', deletedAt: 1 })], []);
    expect(items).toHaveLength(0);
  });
});

describe('classesOnDate', () => {
  it("keeps only the weekday's active slots", () => {
    const tuesday = entry({ id: 'c1' });
    const wednesday = entry({ id: 'c2', dayOfWeek: 3 });
    const switchedOff = entry({ id: 'c3', isActive: false });

    const slots = classesOnDate([tuesday, wednesday, switchedOff], DATE, ZONE);
    expect(slots.map((s) => s.entry.id)).toEqual(['c1']);
    expect(slots[0]!.startsAt).toBe(at('08:00'));
    expect(slots[0]!.endsAt).toBe(at('08:45'));
  });

  it('honours odd/even week parity', () => {
    const odd = epochToLocal(localToEpoch(DATE, ZONE), ZONE).weekNumber % 2 === 1;
    const matching = entry({ id: 'match', weekParity: odd ? 'odd' : 'even' });
    const other = entry({ id: 'other', weekParity: odd ? 'even' : 'odd' });

    const slots = classesOnDate([matching, other], DATE, ZONE);
    expect(slots.map((s) => s.entry.id)).toEqual(['match']);
  });

  it('carries a slot that runs past midnight into the next day', () => {
    const late = entry({ id: 'c1', startTime: '23:00', endTime: '00:30' });
    const [slot] = classesOnDate([late], DATE, ZONE);
    expect(slot!.endsAt).toBeGreaterThan(slot!.startsAt);
    expect(durationMinutes(slot!.startsAt, slot!.endsAt)).toBe(90);
  });
});

describe('density', () => {
  it('counts real events per day and ignores buffers', () => {
    const counts = countByDate(
      [
        event({ id: 'e1' }),
        event({ id: 'e2', startsAt: at('14:00'), endsAt: at('15:00') }),
        event({ id: 'b1', kind: 'buffer', bufferForId: 'e1' }),
        event({ id: 'x', deletedAt: 5 }),
      ],
      ZONE,
    );
    expect(counts.get(DATE)).toBe(2);
  });

  it('caps the dots at three', () => {
    expect([0, 1, 2, 3, 4, 5, 12].map(densityDots)).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });
});

describe('describeSync', () => {
  it('only promises a sync when there is an account to sync to', () => {
    const pending = { syncStatus: 'pending', syncError: null } as const;
    expect(describeSync(pending, { googleConnected: true }).label).toBe('Syncing…');
    expect(describeSync(pending, { googleConnected: false }).label).toBe('On this device only');
  });

  it('surfaces the failure reason', () => {
    const failed = { syncStatus: 'failed', syncError: 'quota exceeded' } as const;
    expect(describeSync(failed, { googleConnected: true })).toMatchObject({
      label: 'Sync failed',
      detail: 'quota exceeded',
      tone: 'danger',
    });
  });

  it('reports a synced row as synced', () => {
    expect(
      describeSync({ syncStatus: 'synced', syncError: null }, { googleConnected: true }).tone,
    ).toBe('success');
  });
});

describe('week and month geometry', () => {
  it('opens the week on Monday or Sunday as configured', () => {
    const tuesday = localToEpoch(DATE, ZONE);
    expect(weekDates(startOfWeek(tuesday, ZONE, 1), ZONE)[0]).toBe('2026-08-10');
    expect(weekDates(startOfWeek(tuesday, ZONE, 0), ZONE)[0]).toBe('2026-08-09');
  });

  it('treats a Sunday as the start of its own Sunday-first week', () => {
    const sunday = localToEpoch('2026-08-16', ZONE);
    expect(weekDates(startOfWeek(sunday, ZONE, 0), ZONE)[0]).toBe('2026-08-16');
    expect(weekDates(startOfWeek(sunday, ZONE, 1), ZONE)[0]).toBe('2026-08-10');
  });

  it('counts whole weeks between two week starts', () => {
    const base = startOfWeek(localToEpoch(DATE, ZONE), ZONE, 1);
    const later = startOfWeek(localToEpoch('2026-09-01', ZONE), ZONE, 1);
    expect(weeksBetween(base, later, ZONE)).toBe(3);
    expect(weeksBetween(later, base, ZONE)).toBe(-3);
  });

  it('builds a six-week grid that starts on the configured weekday', () => {
    const grid = monthGrid(localToEpoch(DATE, ZONE), ZONE, 1);
    expect(grid).toHaveLength(42);
    expect(weekdayIndexOf(grid[0]!, ZONE)).toBe(0);
    expect(grid).toContain('2026-08-01');
    expect(grid).toContain('2026-08-31');
  });

  it('names the month it is given', () => {
    expect(formatMonthLabel(localToEpoch(DATE, ZONE), ZONE)).toBe('August 2026');
  });
});

/**
 * The thing a stack of cards could not say.
 *
 * Both facts here are ones the calendar screen was silent about while the Today
 * screen said CLASH about the very same pair.
 */
describe('joinsOf', () => {
  const build = (spans: [string, string][]) =>
    buildAgenda(
      spans.map(([from, to], i) => event({ id: `e${i}`, startsAt: at(from), endsAt: at(to) })),
      [],
    );

  it('says nothing above the first item', () => {
    expect(joinsOf(build([['09:00', '10:00']]))).toEqual([null]);
  });

  it('names free time worth naming, and stays quiet about a walk between rooms', () => {
    expect(joinsOf(build([['09:00', '10:00'], ['14:00', '15:00']]))[1]).toEqual({
      kind: 'gap',
      minutes: 240,
    });
    // Ten minutes is not free time.
    expect(joinsOf(build([['09:00', '10:00'], ['10:10', '11:00']]))[1]).toEqual({ kind: 'butt' });
    // Exactly the floor counts.
    expect(joinsOf(build([['09:00', '10:00'], ['10:45', '11:00']]))[1]).toEqual({
      kind: 'gap',
      minutes: 45,
    });
  });

  it('measures a collision by how much of the later thing is covered', () => {
    // The meeting sits wholly inside the class, so the whole hour of it
    // clashes. Measuring to the class's end instead reported 2h — a figure
    // larger than the meeting it was describing.
    expect(joinsOf(build([['14:00', '17:00'], ['15:00', '16:00']]))[1]).toEqual({
      kind: 'overlap',
      minutes: 60,
    });
    // Partly covered: only the overlapping half counts.
    expect(joinsOf(build([['14:00', '15:00'], ['14:30', '16:00']]))[1]).toEqual({
      kind: 'overlap',
      minutes: 30,
    });
  });

  /**
   * The reason this measures the furthest end seen rather than the previous
   * item's: both meetings are inside the class, and comparing each to the one
   * before it clears the second the moment the first ends.
   */
  it('keeps marking overlaps while the long thing is still running', () => {
    const joins = joinsOf(
      build([['14:00', '17:00'], ['15:00', '15:30'], ['16:00', '16:30']]),
    );
    expect(joins[1]?.kind).toBe('overlap');
    expect(joins[2]?.kind).toBe('overlap');
  });

  it('counts a buffer as the start of the thing it belongs to', () => {
    // The travel block is drawn attached above its meeting, so the gap the eye
    // sees ends where the *buffer* starts, not where the meeting does.
    const items = buildAgenda(
      [
        event({ id: 'a', startsAt: at('09:00'), endsAt: at('10:00') }),
        event({ id: 'b', startsAt: at('12:00'), endsAt: at('13:00') }),
        event({
          id: 'buf',
          kind: 'buffer',
          bufferForId: 'b',
          startsAt: at('11:40'),
          endsAt: at('12:00'),
        }),
      ],
      [],
    );
    // 100 minutes to the travel block, not 180 to the meeting behind it.
    expect(joinsOf(items)[1]).toEqual({ kind: 'gap', minutes: 100 });
  });
});
