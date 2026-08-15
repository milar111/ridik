import { DateTime, dayRange } from '@/core/time';
import type { TodaySnapshot } from '@/hooks/useToday';
import {
  WIDGET_SNAPSHOT_VERSION,
  buildWidgetSnapshot,
  widgetSnapshotChanged,
} from '../snapshot';

const ZONE = 'Europe/Sofia';
const { start: DAY_START, end: DAY_END } = dayRange('2026-08-11', ZONE);
const at = (hhmm: string): number => DateTime.fromISO(`2026-08-11T${hhmm}`, { zone: ZONE }).toMillis();
const NOON = at('12:00');

/* eslint-disable @typescript-eslint/no-explicit-any */
const snapshot = (over: Partial<TodaySnapshot> = {}): TodaySnapshot =>
  ({
    date: '2026-08-11',
    zone: ZONE,
    at: NOON,
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
  }) as TodaySnapshot;

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

const task = (id: string, dueDate: number | null = null): any => ({
  id,
  title: id,
  dueDate,
  isCompleted: false,
});
let born = 0;
const habit = (name: string, loggedToday: boolean, streak = 1, createdAt?: number): any => ({
  habit: { id: name, name, createdAt: createdAt ?? ++born, longestStreak: streak },
  loggedToday,
  streak,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('buildWidgetSnapshot', () => {
  it('carries the next thing, when to leave, and the counts worth a glance', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot({
        events: [
          event('m', 'Project meeting', at('15:00'), { location: 'Maker lab' }),
          event('b', 'Travel / prep', at('14:40'), {
            kind: 'buffer',
            bufferForId: 'm',
            endsAt: at('15:00'),
          }),
        ],
        dueTasks: [task('a'), task('b')],
        overdueTasks: [task('c')],
        habits: [habit('Gym', true), habit('Reading', false), habit('Study', true)],
      }),
      now: NOON,
    });

    expect(built).toMatchObject({
      version: WIDGET_SNAPSHOT_VERSION,
      publishedAt: NOON,
      next: {
        title: 'Project meeting',
        startsAt: at('15:00'),
        leaveAt: at('14:40'),
        location: 'Maker lab',
      },
      tasks: { dueToday: 2, overdue: 1 },
      habits: { done: 2, total: 3 },
    });
  });

  it('lists what is left of the day, and drops the travel buffer from it', () => {
    // The buffer is a hint about when to leave — `next.leaveAt` already carries
    // it. Drawn as its own agenda row it reads as a second appointment.
    const built = buildWidgetSnapshot({
      snapshot: snapshot({
        events: [
          event('done', 'Standup', at('09:00')),
          event('m', 'Project meeting', at('15:00'), { location: 'Maker lab' }),
          event('b', 'Travel / prep', at('14:40'), {
            kind: 'buffer',
            bufferForId: 'm',
            endsAt: at('15:00'),
          }),
        ],
      }),
      now: NOON,
    });

    expect(built.agenda).toEqual([
      {
        title: 'Project meeting',
        startsAt: at('15:00'),
        endsAt: at('16:00'),
        kind: 'event',
        location: 'Maker lab',
      },
    ]);
  });

  it('leads the task rows with what you are most behind on', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot({
        dueTasks: [task('later', at('17:00')), task('sooner', at('13:00')), task('undated')],
        overdueTasks: [task('yesterday', at('09:00'))],
      }),
      now: NOON,
    });

    expect(built.tasks.rows.map((row) => row.title)).toEqual([
      'yesterday',
      'sooner',
      'later',
      'undated',
    ]);
    expect(built.tasks.rows[0]).toEqual({ title: 'yesterday', dueAt: at('09:00'), overdue: true });
  });

  /* A rail is read down its columns — "everything dies on a Sunday" — and that
     read needs the same habit on the same row today as it was yesterday.
     Ordering by whether it is done yet reshuffled the whole board every time
     the user logged anything. */
  it('keeps the habits in the order they were created, whatever is logged', () => {
    const rows = (over: boolean[]) =>
      buildWidgetSnapshot({
        snapshot: snapshot({
          habits: [
            habit('Gym', over[0]!, 9, 100),
            habit('Reading', over[1]!, 2, 200),
            habit('Study', over[2]!, 40, 300),
          ],
        }),
        now: NOON,
      }).habits.rows.map((row) => row.name);

    expect(rows([false, false, false])).toEqual(['Gym', 'Reading', 'Study']);
    expect(rows([true, false, true])).toEqual(['Gym', 'Reading', 'Study']);
    expect(rows([true, true, true])).toEqual(['Gym', 'Reading', 'Study']);
  });

  it('counts what is done without reordering it', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot({
        habits: [habit('Gym', true, 9), habit('Reading', false, 2), habit('Study', false, 40)],
      }),
      now: NOON,
    });

    expect(built.habits).toMatchObject({ done: 1, total: 3 });
  });

  it('counts a list before capping it, so "of 12" stays true', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ text: `Item ${i}`, done: i < 3 }));
    const built = buildWidgetSnapshot({
      snapshot: snapshot(),
      now: NOON,
      list: { name: 'Hardware', rows },
    });

    expect(built.list?.open).toBe(9);
    expect(built.list?.rows).toHaveLength(6);
    expect(built.list?.rows.every((row) => !row.done)).toBe(true);
  });

  it('says there is no list rather than drawing an empty one', () => {
    expect(buildWidgetSnapshot({ snapshot: snapshot(), now: NOON }).list).toBeNull();
  });

  it('leaves the time as an instant for the widget to count down to itself', () => {
    // Pre-formatting "in 3 hours" here would freeze at publish time, and the
    // widget would have to be woken every minute to keep it true. Both
    // platforms can render a countdown to a date without being woken at all.
    const built = buildWidgetSnapshot({
      snapshot: snapshot({ events: [event('m', 'Lab', at('15:00'))] }),
      now: NOON,
    });

    expect(typeof built.next?.startsAt).toBe('number');
  });

  it('reports no next thing rather than yesterday once the day is done', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot({ events: [event('m', 'Standup', at('09:00'))] }),
      now: at('18:00'),
    });

    expect(built.next).toBeNull();
  });
});

describe('widgetSnapshotChanged', () => {
  const base = () => buildWidgetSnapshot({ snapshot: snapshot(), now: NOON });

  it('publishes the first one', () => {
    expect(widgetSnapshotChanged(null, base())).toBe(true);
  });

  /* Both platforms ration widget reloads and iOS will quietly stop honouring
     them, so a clock tick that changed nothing must not spend one. */
  it('does not spend a reload on a snapshot that only has a newer timestamp', () => {
    const before = base();
    const after = buildWidgetSnapshot({ snapshot: snapshot(), now: NOON + 60_000 });

    expect(after.publishedAt).not.toBe(before.publishedAt);
    expect(widgetSnapshotChanged(before, after)).toBe(false);
  });

  it('notices a task ticked off', () => {
    const before = base();
    const after = buildWidgetSnapshot({
      snapshot: snapshot({ dueTasks: [task('a')] }),
      now: NOON,
    });

    expect(widgetSnapshotChanged(before, after)).toBe(true);
  });

  /* Every section a face draws has to be in the comparison, or that widget
     silently stops redrawing — and the counts alone would miss all of these. */
  it('notices a row changing inside a section whose counts did not', () => {
    const before = buildWidgetSnapshot({
      snapshot: snapshot({ habits: [habit('Gym', false, 3)] }),
      now: NOON,
    });
    const after = buildWidgetSnapshot({
      snapshot: snapshot({ habits: [habit('Gym', false, 4)] }),
      now: NOON,
    });

    expect(before.habits.done).toBe(after.habits.done);
    expect(widgetSnapshotChanged(before, after)).toBe(true);
  });

  it('notices an item ticked off a list', () => {
    const list = (done: boolean) => ({ name: 'Hardware', rows: [{ text: 'M4 bolts', done }] });
    const before = buildWidgetSnapshot({ snapshot: snapshot(), now: NOON, list: list(false) });
    const after = buildWidgetSnapshot({ snapshot: snapshot(), now: NOON, list: list(true) });

    expect(widgetSnapshotChanged(before, after)).toBe(true);
  });

  it('notices the next thing changing under a clock that moved on', () => {
    const events = [event('a', 'Standup', at('13:00')), event('b', 'Lab', at('16:00'))];
    const before = buildWidgetSnapshot({ snapshot: snapshot({ events }), now: NOON });
    const after = buildWidgetSnapshot({ snapshot: snapshot({ events }), now: at('15:00') });

    expect(before.next?.title).toBe('Standup');
    expect(after.next?.title).toBe('Lab');
    expect(widgetSnapshotChanged(before, after)).toBe(true);
  });
});

describe('the day element', () => {
  const day = (over: Partial<TodaySnapshot> = {}, now = NOON) =>
    buildWidgetSnapshot({ snapshot: snapshot(over), now }).day;

  /* An empty day is still a drawing: 32 cold cells with a shape and a scale.
     This is the whole answer to "the widgets are blank and boring". */
  it('draws a full strip of cold cells on a day with nothing in it', () => {
    const built = day();

    expect(built.load).toHaveLength(32);
    expect(built.load).toBe('0'.repeat(32));
    expect(built.startMinute).toBe(7 * 60);
    expect(built.cellMinutes).toBe(30);
    expect(built.freeMinutes).toBe(16 * 60);
    expect(built.nextCell).toBe(-1);
  });

  it('claims the cells an event covers and marks where the next one starts', () => {
    const built = day({ events: [event('m', 'Lab', at('15:00'), { endsAt: at('16:00') })] });

    // 07:00 is cell 0, so 15:00 is cell 16 and 15:30 is cell 17.
    expect(built.load[16]).toBe('3');
    expect(built.load[17]).toBe('2');
    expect(built.load[18]).toBe('0');
    expect(built.nextCell).toBe(16);
    expect(built.freeMinutes).toBe(16 * 60 - 60);
  });

  /* An event ending exactly on a boundary does not own the cell it ends on —
     a 15:00-16:00 meeting leaves you free at 16:00. */
  it('does not claim the cell an event ends on', () => {
    const built = day(
      { events: [event('m', 'Lab', at('15:00'), { endsAt: at('16:00') })] },
      at('20:00'),
    );

    expect(built.load[18]).toBe('0');
  });

  /* Two back-to-back meetings are four adjacent claimed cells, and without a
     boundary they read as one long block — a different and wrong answer to
     "how is my afternoon". */
  it('marks the start of each booking so back-to-back meetings stay separate', () => {
    const built = day(
      {
        events: [
          event('a', 'First', at('15:00'), { endsAt: at('16:00') }),
          event('b', 'Second', at('16:00'), { endsAt: at('17:00') }),
        ],
      },
      at('20:00'),
    );

    expect(built.load.slice(16, 20)).toBe('2222');
    expect(built.breaks.slice(16, 20)).toBe('1010');
  });

  /* Clamping is right — a 06:00 meeting should darken the first cell rather
     than vanish — but drawing a boundary there would claim the day starts with
     something it does not. */
  it('clamps an event that starts before the window without inventing a break', () => {
    const built = day(
      { events: [event('early', 'Gym', at('05:30'), { endsAt: at('08:00') })] },
      at('20:00'),
    );

    expect(built.load[0]).toBe('2');
    expect(built.breaks[0]).toBe('0');
  });

  /* The travel buffer is a hint about when to leave, carried by next.leaveAt.
     Drawn as claimed time it would book the twenty minutes before everything. */
  it('leaves the travel buffer out of the load', () => {
    const built = day(
      {
        events: [
          event('m', 'Lab', at('15:00'), { endsAt: at('16:00') }),
          event('b', 'Travel', at('14:30'), { kind: 'buffer', bufferForId: 'm', endsAt: at('15:00') }),
        ],
      },
      at('20:00'),
    );

    expect(built.load[15]).toBe('0');
  });
});

describe('the month plate', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const onDay = (day: number, hours: number, over: Record<string, unknown> = {}): any =>
    event(`d${day}`, `Day ${day}`, DateTime.fromISO(`2026-08-${String(day).padStart(2, '0')}T09:00`, { zone: ZONE }).toMillis(), {
      endsAt: DateTime.fromISO(`2026-08-${String(day).padStart(2, '0')}T09:00`, { zone: ZONE }).toMillis() + hours * 3_600_000,
      ...over,
    });
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('draws a cold cell for every day of the month, and marks today', () => {
    const built = buildWidgetSnapshot({ snapshot: snapshot(), now: NOON }).month;

    expect(built.load).toHaveLength(31);
    expect(built.load).toBe('0'.repeat(31));
    expect(built.month).toBe('2026-08');
    expect(built.today).toBe(11);
    expect(built.weekStartsOn).toBe(1);
  });

  it('separates a busy day from one with a single meeting on it', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot(),
      now: NOON,
      monthEvents: [onDay(3, 1), onDay(19, 4)],
    }).month;

    expect(built.load[2]).toBe('1');
    expect(built.load[18]).toBe('2');
    expect(built.load[0]).toBe('0');
  });

  /* Today is the only hot cell on any tile in the family. A month with a hot
     cell on the 3rd and another on the 19th has no focus at all. */
  it('never draws a day hotter than "busy", however full it is', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot(),
      now: NOON,
      monthEvents: [onDay(19, 10)],
    }).month;

    expect(built.load).not.toContain('3');
  });

  it('reads an all-day event as busy rather than as twenty-four hours', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot(),
      now: NOON,
      monthEvents: [onDay(7, 0, { allDay: true })],
    }).month;

    expect(built.load[6]).toBe('1');
  });
});

describe('the empty-state distinctions', () => {
  /* "You have done all your habits" and "you have never added a habit" render
     identically without this, and that is most of why an untouched app's
     widgets look broken. */
  it('separates never-set-up from nothing-today', () => {
    const untouched = buildWidgetSnapshot({
      snapshot: snapshot(),
      now: NOON,
      counts: { events: 0, tasks: 0, habits: 0, lists: 0 },
    });
    const quiet = buildWidgetSnapshot({
      snapshot: snapshot(),
      now: NOON,
      counts: { events: 12, tasks: 4, habits: 6, lists: 2 },
    });

    expect(untouched.configured).toEqual({
      calendar: false,
      tasks: false,
      habits: false,
      lists: false,
    });
    expect(quiet.configured).toEqual({
      calendar: true,
      tasks: true,
      habits: true,
      lists: true,
    });
  });

  it('falls back to what today holds when no counts are supplied', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot({ habits: [habit('Gym', false)] }),
      now: NOON,
    });

    expect(built.configured.habits).toBe(true);
    expect(built.configured.tasks).toBe(false);
  });
});

describe('task ages and all-day events', () => {
  it('publishes how many days late each task is, oldest first', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot({
        overdueTasks: [task('a', at('09:00') - 2 * 86_400_000), task('b', at('09:00') - 9 * 86_400_000)],
        dueTasks: [task('c', at('17:00'))],
      }),
      now: NOON,
    });

    expect(built.tasks.ages).toEqual([9, 2, 0]);
  });

  /* Dropped entirely before v3, which lost whole days: "flying to Berlin" is
     exactly what a glance at a calendar widget should say. */
  it('carries all-day events rather than losing them', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot({
        events: [event('trip', 'Flying to Berlin', at('00:00'), { allDay: true, endsAt: at('23:59') })],
      }),
      now: NOON,
    });

    expect(built.allDay).toEqual(['Flying to Berlin']);
  });
});

describe('habit history', () => {
  it('ends the strip on the day the snapshot describes', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot({ habits: [habit('Gym', true)] }),
      now: NOON,
      habitHistory: { Gym: ['2026-08-11', '2026-08-10', '2026-08-08'] },
    });

    const history = built.habits.rows[0]!.history;
    expect(history).toHaveLength(35);
    expect(history.at(-1)).toBe('1');
    expect(history.at(-2)).toBe('1');
    expect(history.at(-3)).toBe('0');
    expect(history.at(-4)).toBe('1');
  });

  it('draws a cold strip for a habit with no history at all', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot({ habits: [habit('New', false)] }),
      now: NOON,
    });

    expect(built.habits.rows[0]!.history).toBe('0'.repeat(35));
  });
});

/* A section missing from digest() publishes once and then never redraws, with
   nothing failing anywhere. This is the one thing in the file that can ship
   broken in silence, so it is checked section by section. */
describe('every section reaches the change check', () => {
  const base = buildWidgetSnapshot({ snapshot: snapshot(), now: NOON });

  const mutations: [string, () => WidgetSnapshotLike][] = [
    ['day.load', () => buildWidgetSnapshot({
      snapshot: snapshot({ events: [event('m', 'Lab', at('15:00'))] }),
      now: NOON,
    })],
    ['month.load', () => buildWidgetSnapshot({
      snapshot: snapshot(),
      now: NOON,
      monthEvents: [event('m', 'Lab', at('15:00'))],
    })],
    ['configured', () => buildWidgetSnapshot({
      snapshot: snapshot(),
      now: NOON,
      counts: { events: 3, tasks: 0, habits: 0, lists: 0 },
    })],
    ['tasks.ages', () => buildWidgetSnapshot({
      snapshot: snapshot({ overdueTasks: [task('a', at('09:00') - 86_400_000)] }),
      now: NOON,
    })],
    ['allDay', () => buildWidgetSnapshot({
      snapshot: snapshot({
        events: [event('t', 'Berlin', at('00:00'), { allDay: true, endsAt: at('23:59') })],
      }),
      now: NOON,
    })],
    ['habits.rows', () => buildWidgetSnapshot({
      snapshot: snapshot({ habits: [habit('Gym', false)] }),
      now: NOON,
    })],
    ['list', () => buildWidgetSnapshot({
      snapshot: snapshot(),
      now: NOON,
      list: { name: 'Hardware', rows: [{ text: 'Bolts', done: false }] },
    })],
  ];

  it.each(mutations)('notices a change in %s', (_section, build) => {
    expect(widgetSnapshotChanged(base, build())).toBe(true);
  });
});

type WidgetSnapshotLike = ReturnType<typeof buildWidgetSnapshot>;
