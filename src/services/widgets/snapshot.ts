/**
 * The payload a home-screen widget renders.
 *
 * Neither WidgetKit nor an Android AppWidgetProvider can run this app's
 * JavaScript or open its SQLite file — they wake in their own process, with a
 * few milliseconds and no access to anything the app has in memory. So the app
 * publishes; the widget only reads.
 *
 * That constraint shapes everything here. The payload is small, already
 * formatted, and carries no ids: a widget cannot follow a foreign key, and
 * anything it would have to compute is computed once, here, where it can be
 * tested. Times stay as epoch ms — the one thing a widget genuinely can do for
 * itself is count down to a `Date`, and it should, or every widget in the grid
 * would need waking each minute just to redraw a clock.
 *
 * Pure and native-free, so the whole shape can be asserted under plain Node
 * without a simulator, a widget target or a rebuild.
 */
import type { TodaySnapshot } from '@/hooks/useToday';
import { buildAgenda } from '@/features/today/agenda';
import { nextUp } from '@/features/home/next';

/** Bumped when the shape changes, so a stale widget can tell and say nothing. */
export const WIDGET_SNAPSHOT_VERSION = 1;

export type WidgetSnapshot = {
  version: number;
  /** When this was published; the widget shows staleness rather than lying. */
  publishedAt: number;
  next: {
    title: string;
    startsAt: number;
    /** Epoch ms of the travel buffer's start, when the event earned one. */
    leaveAt: number | null;
    location: string | null;
  } | null;
  tasks: {
    dueToday: number;
    overdue: number;
  };
  habits: {
    /** Habits with something logged today. */
    done: number;
    total: number;
  };
};

export type BuildWidgetSnapshotInput = {
  snapshot: TodaySnapshot;
  now: number;
};

export function buildWidgetSnapshot({ snapshot, now }: BuildWidgetSnapshotInput): WidgetSnapshot {
  const agenda = buildAgenda({
    events: snapshot.events,
    classes: snapshot.classes,
    window: { start: snapshot.dayStart, end: snapshot.dayEnd },
    now,
  });
  // Same rule as the home screen, and deliberately the same function: a widget
  // that disagreed with the app about what is next would be worse than none.
  const upcoming = nextUp(agenda, now);

  return {
    version: WIDGET_SNAPSHOT_VERSION,
    publishedAt: now,
    next: upcoming
      ? {
          title: upcoming.item.title,
          startsAt: upcoming.item.startsAt,
          leaveAt: upcoming.leaveAt,
          location: upcoming.item.location,
        }
      : null,
    tasks: {
      dueToday: snapshot.dueTasks.length,
      overdue: snapshot.overdueTasks.length,
    },
    habits: {
      done: snapshot.habits.filter((entry) => entry.loggedToday).length,
      total: snapshot.habits.length,
    },
  };
}

/**
 * Whether a republish is worth waking the widget for.
 *
 * Both platforms ration widget reloads — iOS budgets them per day and will
 * quietly stop honouring them — so publishing on every query settle would spend
 * the budget redrawing an identical face. `publishedAt` is excluded from the
 * comparison for exactly that reason: it changes every single time.
 */
export function widgetSnapshotChanged(a: WidgetSnapshot | null, b: WidgetSnapshot): boolean {
  if (!a) return true;
  return (
    a.version !== b.version ||
    a.next?.title !== b.next?.title ||
    a.next?.startsAt !== b.next?.startsAt ||
    a.next?.leaveAt !== b.next?.leaveAt ||
    a.next?.location !== b.next?.location ||
    a.tasks.dueToday !== b.tasks.dueToday ||
    a.tasks.overdue !== b.tasks.overdue ||
    a.habits.done !== b.habits.done ||
    a.habits.total !== b.habits.total
  );
}
