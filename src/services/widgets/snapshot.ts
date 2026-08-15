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
export const WIDGET_SNAPSHOT_VERSION = 2;

/**
 * Lists are capped hard. A widget draws four or five rows at most, and every
 * extra row is bytes crossing a process boundary on every publish for nothing.
 */
const ROW_CAP = 6;

export type WidgetAgendaRow = {
  title: string;
  startsAt: number;
  endsAt: number;
  /** 'class' and 'buffer' are drawn differently from a plain event. */
  kind: string;
  location: string | null;
};

export type WidgetTaskRow = {
  title: string;
  /** Epoch ms, or null for a task due today with no time on it. */
  dueAt: number | null;
  overdue: boolean;
};

export type WidgetHabitRow = {
  name: string;
  doneToday: boolean;
  streak: number;
};

export type WidgetListRow = { text: string; done: boolean };

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
    /** Overdue first, then by due time — the order a list widget draws them. */
    rows: WidgetTaskRow[];
  };
  habits: {
    /** Habits with something logged today. */
    done: number;
    total: number;
    /** Not-yet-done first: a habit widget is a prompt, not a scoreboard. */
    rows: WidgetHabitRow[];
  };
  /** What is left of today, in order. Empty once the day is behind you. */
  agenda: WidgetAgendaRow[];
  /** The list the user touched most recently, or null when there are none. */
  list: { name: string; open: number; rows: WidgetListRow[] } | null;
};

export type BuildWidgetSnapshotInput = {
  snapshot: TodaySnapshot;
  now: number;
  /** The most recently touched checklist, when there is one. */
  list?: { name: string; rows: WidgetListRow[] } | null;
};

export function buildWidgetSnapshot({ snapshot, now, list }: BuildWidgetSnapshotInput): WidgetSnapshot {
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
      // Overdue first and oldest first inside that: the thing you are most
      // behind on is the row worth the top of a widget.
      rows: [
        ...[...snapshot.overdueTasks].sort(byDue).map((task) => toTaskRow(task, true)),
        ...[...snapshot.dueTasks].sort(byDue).map((task) => toTaskRow(task, false)),
      ].slice(0, ROW_CAP),
    },
    habits: {
      done: snapshot.habits.filter((entry) => entry.loggedToday).length,
      total: snapshot.habits.length,
      // Undone first. A habit widget is a prompt, and a prompt that leads with
      // what you already did is a scoreboard.
      rows: [...snapshot.habits]
        .sort((a, b) => Number(a.loggedToday) - Number(b.loggedToday) || b.streak - a.streak)
        .slice(0, ROW_CAP)
        .map((entry) => ({
          name: entry.habit.name,
          doneToday: entry.loggedToday,
          streak: entry.streak,
        })),
    },
    // Only what has not finished — the same rule `nextUp` applies, so the
    // agenda widget and the Today widget can never disagree about the day.
    agenda: agenda.timed
      .filter((item) => item.endsAt > now && item.kind !== 'buffer')
      .slice(0, ROW_CAP)
      .map((item) => ({
        title: item.title,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        kind: item.kind,
        location: item.location,
      })),
    list: list
      ? {
          name: list.name,
          // Counted before the cap, so "4 of 12" stays true on a long list.
          open: list.rows.filter((row) => !row.done).length,
          // Open items first: a shopping list widget is for what is left.
          rows: [...list.rows]
            .sort((a, b) => Number(a.done) - Number(b.done))
            .slice(0, ROW_CAP),
        }
      : null,
  };
}

/** Undated sorts last: a task with no time on it is not more urgent than 09:00. */
function byDue(a: { dueDate: number | null }, b: { dueDate: number | null }): number {
  if (a.dueDate === null) return b.dueDate === null ? 0 : 1;
  if (b.dueDate === null) return -1;
  return a.dueDate - b.dueDate;
}

function toTaskRow(task: { title: string; dueDate: number | null }, overdue: boolean): WidgetTaskRow {
  return { title: task.title, dueAt: task.dueDate, overdue };
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
    a.habits.total !== b.habits.total ||
    // Compared as rendered rather than field by field: these are short, and a
    // section that is not in this check is a widget that silently stops
    // redrawing — the failure mode is invisible and the cost is a string
    // compare on a publish that already happens at most once a minute.
    digest(a) !== digest(b)
  );
}

/** Everything the faces draw, minus `publishedAt`, which changes every time. */
function digest(snapshot: WidgetSnapshot): string {
  return JSON.stringify([snapshot.agenda, snapshot.tasks.rows, snapshot.habits.rows, snapshot.list]);
}
