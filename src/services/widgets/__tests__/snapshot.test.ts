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
const habit = (name: string, loggedToday: boolean, streak = 1): any => ({
  habit: { id: name, name },
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

  it('prompts with the habits still owed rather than the ones already done', () => {
    const built = buildWidgetSnapshot({
      snapshot: snapshot({
        habits: [habit('Gym', true, 9), habit('Reading', false, 2), habit('Study', false, 40)],
      }),
      now: NOON,
    });

    expect(built.habits.rows.map((row) => row.name)).toEqual(['Study', 'Reading', 'Gym']);
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
