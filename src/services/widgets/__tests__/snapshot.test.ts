import { DateTime, dayRange } from '@/core/time';
import type { TodaySnapshot } from '@/hooks/useToday';
import { DEFAULT_EMBER } from '@/ui/theme';
import {
  WIDGET_SNAPSHOT_VERSION,
  buildWidgetSnapshot,
  widgetSnapshotChanged,
} from '../snapshot';

const ZONE = 'Europe/Sofia';
const { start: DAY_START, end: DAY_END } = dayRange('2026-08-11', ZONE);
const at = (hhmm: string): number => DateTime.fromISO(`2026-08-11T${hhmm}`, { zone: ZONE }).toMillis();
const NOON = at('12:00');

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

  /* The colour travels by name and the scheme does not (WIDGETS §5): the
     launcher can be dark while the app is light, and only the widget can know
     that — but no launcher can know which ember the person chose. */
  it('carries the chosen ember, and still no scheme', () => {
    const built = buildWidgetSnapshot({ snapshot: snapshot(), now: NOON, ember: 'rust' });

    expect(built.ember).toBe('rust');
    expect(Object.keys(built)).not.toContain('scheme');
  });

  it('publishes the default for a build that has not been told otherwise', () => {
    expect(buildWidgetSnapshot({ snapshot: snapshot(), now: NOON }).ember).toBe(DEFAULT_EMBER);
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
    // Both counts survive the cap, or the tile says "4 of 6" about a list of 12.
    expect(built.list?.total).toBe(12);
    // Eleven, not six: the list is the one face with a large size, and
    // `LIST_ROW_CAP` feeds it. The point of the test is that `open` and `total`
    // are counted *before* whatever the cap is — not what the cap happens to be.
    expect(built.list?.rows).toHaveLength(11);
    // Open first, still. Nine open rows fill most of the cap and the two ticked
    // ones that fit come after them, which is what lets a face ration the ticked
    // rows by taking from the end rather than re-sorting the list itself.
    expect(built.list?.rows.slice(0, 9).every((row) => !row.done)).toBe(true);
    expect(built.list?.rows.slice(9).every((row) => row.done)).toBe(true);
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
  const onDay = (day: number, hours: number, over: Record<string, unknown> = {}): any =>
    event(`d${day}`, `Day ${day}`, DateTime.fromISO(`2026-08-${String(day).padStart(2, '0')}T09:00`, { zone: ZONE }).toMillis(), {
      endsAt: DateTime.fromISO(`2026-08-${String(day).padStart(2, '0')}T09:00`, { zone: ZONE }).toMillis() + hours * 3_600_000,
      ...over,
    });
   

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
    /* The one field here that draws nothing and changes everything. Left out of
       the digest, picking a colour republishes nothing: the tiles keep the old
       one until something else about the day happens to change. */
    ['ember', () => buildWidgetSnapshot({ snapshot: snapshot(), now: NOON, ember: 'kiln' })],
  ];

  it.each(mutations)('notices a change in %s', (_section, build) => {
    expect(widgetSnapshotChanged(base, build())).toBe(true);
  });
});

type WidgetSnapshotLike = ReturnType<typeof buildWidgetSnapshot>;

/* The plate's question is "is the 19th free", and a timetabled Monday is not
   free. Counting only calendar rows drew an empty week for anyone whose week
   is lessons — which is this app's central user, and the face they asked for. */
describe('the month plate counts classes as well as events', () => {
  const onDay = (day: number, fromHour: number, hours: number) => ({
    startsAt: DateTime.fromISO(`2026-08-${String(day).padStart(2, '0')}T${String(fromHour).padStart(2, '0')}:00`, { zone: ZONE }).toMillis(),
    endsAt: DateTime.fromISO(`2026-08-${String(day).padStart(2, '0')}T${String(fromHour).padStart(2, '0')}:00`, { zone: ZONE }).toMillis() + hours * 3_600_000,
    allDay: false,
  });

  it('shades a day whose only commitment is a class', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot(),
      now: NOON,
      monthEvents: [onDay(17, 9, 1)],
    }).month;

    expect(built.load[16]).not.toBe('0');
  });

  it('adds a class to an event on the same day rather than replacing it', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot(),
      now: NOON,
      // One hour of lesson plus one hour of meeting is two hours: "busy".
      monthEvents: [onDay(17, 9, 1), onDay(17, 14, 1.5)],
    }).month;

    expect(built.load[16]).toBe('2');
  });
});

/**
 * The week is its own field rather than seven characters sliced out of the
 * month plate, and these tests are about the reason why: a week straddling the
 * 1st is half in a month the plate does not cover, and slicing would draw those
 * days `cold` — indistinguishable from "free". A tile that confidently reports
 * an empty Monday it knows nothing about is the failure this field prevents.
 */
describe('the week', () => {
  it('starts on the Monday of the day the snapshot describes', () => {
    // 2026-08-11 is a Tuesday, so the week starts on the 10th.
    const built = buildWidgetSnapshot({ snapshot: snapshot(), now: NOON });
    expect(built.week.startDate).toBe('2026-08-10');
    expect(built.week.load).toHaveLength(7);
    expect(built.week.todayIndex).toBe(1);
  });

  it('loads each day from the same arithmetic the plate uses', () => {
    const monday = DateTime.fromISO('2026-08-10T09:00', { zone: ZONE }).toMillis();
    const built = buildWidgetSnapshot({
      snapshot: snapshot(),
      now: NOON,
      monthEvents: [
        // Three hours on the Monday: past the two-hour step, so `mid`.
        { startsAt: monday, endsAt: monday + 3 * 3_600_000 },
      ],
    });

    expect(built.week.load[0]).toBe('2');
    // Everything else untouched, and cold rather than absent.
    expect(built.week.load.slice(1)).toBe('000000');
  });

  it('carries a day that falls in the previous month', () => {
    // 2026-09-01 is a Tuesday, so its week starts on Monday 31 August — a day
    // the September plate has no cell for at all.
    const { start, end } = dayRange('2026-09-01', ZONE);
    const augustMonday = DateTime.fromISO('2026-08-31T10:00', { zone: ZONE }).toMillis();
    const built = buildWidgetSnapshot({
      snapshot: snapshot({ date: '2026-09-01', dayStart: start, dayEnd: end, at: start }),
      now: start + 12 * 3_600_000,
      monthEvents: [{ startsAt: augustMonday, endsAt: augustMonday + 4 * 3_600_000 }],
    });

    expect(built.week.startDate).toBe('2026-08-31');
    // The load is real, not cold: this is the whole point of the field.
    expect(built.week.load[0]).toBe('2');
    expect(built.week.todayIndex).toBe(1);
  });

  it('reports -1 for a payload whose day is not in its own week', () => {
    // Reachable from a stale payload: the tile must be able to tell that none
    // of these seven days is today rather than ringing the wrong one.
    const built = buildWidgetSnapshot({ snapshot: snapshot(), now: NOON });
    const stale = { ...built.week, todayIndex: -1 };
    expect(stale.todayIndex).toBe(-1);
  });
});

describe('the focus session', () => {
  const POMODORO = [
    { kind: 'focus' as const, minutes: 25 },
    { kind: 'break' as const, minutes: 5 },
    { kind: 'focus' as const, minutes: 25 },
    { kind: 'break' as const, minutes: 5 },
  ];

  const session = (over: Record<string, unknown> = {}) => ({
    label: 'Materials revision',
    phases: POMODORO,
    phaseIndex: 0,
    phaseStartedAt: NOON,
    pausedAt: null,
    status: 'running' as const,
    ...over,
  });

  it('is null when nothing is running, which is the ordinary case', () => {
    expect(buildWidgetSnapshot({ snapshot: snapshot(), now: NOON }).focus).toBeNull();
  });

  it('cuts the session into sixteen cells of its own length, not the day', () => {
    const built = buildWidgetSnapshot({ snapshot: snapshot(), now: NOON, focus: session() });
    expect(built.focus?.load).toHaveLength(16);
    expect(built.focus?.breaks).toHaveLength(16);
    // 60 minutes over 16 cells is 3.75 minutes each. Focus runs 0–25, so cells
    // 0–6 are focus (26.25 > 25 starts at 26.25, which is the break).
    expect(built.focus?.load).toBe('2222222122222221');
  });

  it('marks a phase boundary and never cell zero', () => {
    const built = buildWidgetSnapshot({ snapshot: snapshot(), now: NOON, focus: session() });
    expect(built.focus?.breaks[0]).toBe('0');
    // The first break cell, and the first cell back on focus after it.
    expect(built.focus?.breaks[7]).toBe('1');
    expect(built.focus?.breaks[8]).toBe('1');
  });

  it('sends the moments the platform counts to, not a duration', () => {
    const built = buildWidgetSnapshot({ snapshot: snapshot(), now: NOON, focus: session() });
    expect(built.focus?.phaseEndsAt).toBe(NOON + 25 * 60_000);
    // The whole plan: 25 running now, then 5 + 25 + 5 still to come.
    expect(built.focus?.endsAt).toBe(NOON + 60 * 60_000);
  });

  it('sends no end at all while paused, rather than a frozen one', () => {
    // A paused session has no end: the minutes left are known, when they finish
    // is not, and a countdown to a receding moment is wrong every second.
    const built = buildWidgetSnapshot({
      snapshot: snapshot(),
      now: NOON + 10 * 60_000,
      focus: session({ status: 'paused', pausedAt: NOON + 6 * 60_000 }),
    });
    expect(built.focus?.status).toBe('paused');
    expect(built.focus?.phaseEndsAt).toBeNull();
    expect(built.focus?.endsAt).toBeNull();
    // And the marker holds where it was paused rather than drifting with the
    // clock — 6 minutes in is cell 1 of a 3.75-minute grid.
    expect(built.focus?.nowCell).toBe(1);
  });

  it('measures elapsed from the phase, never from the session start', () => {
    // Third phase (the second focus block) starts 30 minutes in; two minutes
    // into it is 32 minutes, which is cell 8 of a 3.75-minute grid.
    const built = buildWidgetSnapshot({
      snapshot: snapshot(),
      now: NOON + 2 * 60_000,
      focus: session({ phaseIndex: 2, phaseStartedAt: NOON }),
    });
    expect(built.focus?.nowCell).toBe(8);
    expect(built.focus?.phase).toBe('focus');
  });

  it('reports the phase it is in, because a break is still a session', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot(),
      now: NOON,
      focus: session({ phaseIndex: 1 }),
    });
    expect(built.focus?.phase).toBe('break');
  });

  it('refuses a plan with no minutes in it rather than dividing by zero', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot(),
      now: NOON,
      focus: session({ phases: [{ kind: 'focus' as const, minutes: 0 }] }),
    });
    expect(built.focus).toBeNull();
  });
});
