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

const task = (id: string): any => ({ id, title: id, isCompleted: false });
const habit = (name: string, loggedToday: boolean): any => ({
  habit: { id: name, name },
  loggedToday,
  streak: 1,
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

    expect(built).toEqual({
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

  it('notices the next thing changing under a clock that moved on', () => {
    const events = [event('a', 'Standup', at('13:00')), event('b', 'Lab', at('16:00'))];
    const before = buildWidgetSnapshot({ snapshot: snapshot({ events }), now: NOON });
    const after = buildWidgetSnapshot({ snapshot: snapshot({ events }), now: at('15:00') });

    expect(before.next?.title).toBe('Standup');
    expect(after.next?.title).toBe('Lab');
    expect(widgetSnapshotChanged(before, after)).toBe(true);
  });
});
