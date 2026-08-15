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
 * ## Heat, as a string of digits
 *
 * Every graphic in the family is built from one primitive: a cell, filled with
 * the single ember colour at one of four opacities. So a whole visualisation
 * travels as a string — `"00002233..."` — one character per cell. It is compact,
 * it diffs as a string, and when a test fails you can read the answer.
 *
 * Deliberately digits and never colours: the widget owns the palette, resolves
 * it against the launcher's light/dark setting, and would otherwise be handed a
 * light-mode colour by an app that was in light mode when it published.
 */
import type { TodaySnapshot } from '@/hooks/useToday';
import type { LocalDate } from '@/core/time';
import { DateTime, localDateOf, monthRange } from '@/core/time';
import { buildAgenda } from '@/features/today/agenda';
import { nextUp } from '@/features/home/next';
import { DEFAULT_EMBER, type EmberName } from '@/ui/theme';

/** Bumped when the shape changes, so a stale widget can tell and say nothing. */
export const WIDGET_SNAPSHOT_VERSION = 4;

/**
 * Lists are capped hard. A widget draws four or five rows at most, and every
 * extra row is bytes crossing a process boundary on every publish for nothing.
 */
const ROW_CAP = 6;

/** Task age cells. The count in the footer is the truth; this is the drawing. */
const AGE_CAP = 24;

/** All-day events are a header, not a list. Three is already generous. */
const ALL_DAY_CAP = 3;

/** Days of history per habit rail — five weeks, the largest face's window. */
export const HABIT_HISTORY_DAYS = 35;

/** Minutes per cell of the day element. Thirty is the whole design. */
export const DAY_CELL_MINUTES = 30;

/** 07:00 to 23:00 — the default waking window, overridable from Settings. */
export const DEFAULT_DAY_WINDOW = { startMinute: 7 * 60, endMinute: 23 * 60 };

/**
 * Heat levels, as the characters that travel on the wire.
 *
 * Not an enum: this is a string protocol shared with Swift and Kotlin, and both
 * of them read it a character at a time. `'0'` is the cold cell that the widget
 * draws for "nothing here", which is why an empty day is still a drawing.
 */
export const HEAT = { cold: '0', low: '1', mid: '2', hot: '3' } as const;

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
  longestStreak: number;
  /**
   * `HABIT_HISTORY_DAYS` characters of '0' or '1', oldest first, the last one
   * being the day this snapshot describes. A string rather than an array of
   * booleans because it is a third of the bytes and reads as a picture.
   */
  history: string;
};

export type WidgetListRow = { text: string; done: boolean };

/**
 * The day, as a strip of half-hour cells.
 *
 * The widget draws this and computes "now" from its own clock, so the strip
 * burns down between publishes without anyone being woken. That is the whole
 * reason the window is fixed rather than fitted to the day's own events: a
 * strip that rescaled whenever a meeting was added would be a different picture
 * at 09:00 and 21:00, and the shape of your day is the thing being read.
 */
export type WidgetDay = {
  /** 'YYYY-MM-DD' — the day these numbers describe. */
  date: LocalDate;
  /** Minutes past local midnight of cell 0. */
  startMinute: number;
  /** Minutes per cell. Always `DAY_CELL_MINUTES`. */
  cellMinutes: number;
  /** One heat character per cell, earliest first. */
  load: string;
  /**
   * '1' where a new booking begins, '0' elsewhere.
   *
   * Without this, two back-to-back meetings are four adjacent claimed cells and
   * read as one long block — which is a different and wrong answer to "how is
   * my afternoon". The widget draws a hairline of ground at each '1'.
   */
  breaks: string;
  /** Index into `load` of the next thing's first cell, or -1. */
  nextCell: number;
  /** Minutes of the whole window with nothing in them. */
  freeMinutes: number;
};

/**
 * The month, as a plate of one cell per day.
 *
 * Load only ever reaches `mid` here: `hot` is reserved for today, everywhere in
 * the family, and a month with a hot cell on the 3rd and another on the 19th
 * has no focus at all.
 */
export type WidgetMonth = {
  /** 'YYYY-MM'. */
  month: string;
  /** 1 = Monday. Which column the grid starts on. */
  weekStartsOn: number;
  /** One heat character per day, the 1st first. Only '0', '1' or '2'. */
  load: string;
  /** Day of the month that is today, or 0 when this is not the current month. */
  today: number;
};

/**
 * Whether the user has ever set each thing up.
 *
 * The difference between "you have done all your habits" and "you have never
 * added a habit" — which render identically without this, and that single
 * missing distinction is most of why an untouched app's widgets look broken.
 */
export type WidgetConfigured = {
  calendar: boolean;
  tasks: boolean;
  habits: boolean;
  lists: boolean;
};

export type WidgetSnapshot = {
  version: number;
  /** When this was published; the widget shows staleness rather than lying. */
  publishedAt: number;
  /**
   * The IANA zone the day was computed in.
   *
   * A widget must never guess this. `ZoneId.systemDefault()` is right until the
   * user is travelling, and then every face is wrong by hours while looking
   * entirely plausible.
   */
  zone: string;
  /**
   * The ember the user chose, by name — never as colours.
   *
   * The *scheme* deliberately stays out of this payload (§5): the launcher can
   * be dark while the app is light, and only the widget is in a position to
   * know. An ember is the other kind of fact — a choice the person made, which
   * no launcher can answer for — so it travels, and each platform resolves it
   * against its own light/dark just as it already resolves the default.
   */
  ember: EmberName;
  day: WidgetDay;
  month: WidgetMonth;
  configured: WidgetConfigured;
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
    /** Days overdue per open task, oldest first. 0 is "due today". */
    ages: number[];
    /** Overdue first, then by due time — the order a list widget draws them. */
    rows: WidgetTaskRow[];
  };
  habits: {
    /** Habits with something logged today. */
    done: number;
    total: number;
    /**
     * In the order the habits were created, and never in any other.
     *
     * A rail is read down its columns — "everything dies on a Sunday" — and
     * that read needs the same habit on the same row today as yesterday.
     * Sorting by whether it is done yet reshuffles the whole board every time
     * the user logs anything, which is worse than useless.
     */
    rows: WidgetHabitRow[];
  };
  /** What is left of today, in order. Empty once the day is behind you. */
  agenda: WidgetAgendaRow[];
  /** All-day event titles. Dropped entirely before v3, which lost whole days. */
  allDay: string[];
  /**
   * The list the user still has something open on, or null when there are none.
   *
   * `open` and `total` are both counted *before* the rows are capped, so the
   * header can say "4 of 12" about a list of twelve. Without `total` the widget
   * can only count the rows it was handed, and both platforms independently had
   * to degrade to "4 open" and "All six done." about a list of twelve — a quiet
   * lie in the one place the tile is asked to be a tally.
   */
  list: { name: string; open: number; total: number; rows: WidgetListRow[] } | null;
};

/** Anything that takes up part of a day. A `CalendarEvent` already is one. */
export type MonthInterval = {
  startsAt: number;
  endsAt: number;
  allDay?: boolean | null;
};

export type BuildWidgetSnapshotInput = {
  snapshot: TodaySnapshot;
  now: number;
  /** The most recently touched checklist, when there is one. */
  list?: { name: string; rows: WidgetListRow[] } | null;
  /**
   * Everything that occupies time in the current month, for the plate.
   *
   * Events *and* class occurrences. The plate counted only calendar rows at
   * first, which on a timetabled week is most of the month missing: a student
   * whose Monday is five lessons saw an empty Monday, on the one face whose
   * whole job is "visualise when there is something to do".
   */
  monthEvents?: readonly MonthInterval[];
  /** Habit id to the local dates it was logged on, for the rails. */
  habitHistory?: Readonly<Record<string, readonly LocalDate[]>>;
  /** Existence counts — cheap, and the only thing `configured` needs. */
  counts?: { events: number; tasks: number; habits: number; lists: number };
  /** The waking window, from Settings. Defaults to 07:00–23:00. */
  window?: { startMinute: number; endMinute: number };
  /** The chosen ember, from Settings. Defaults to the one a fresh install draws. */
  ember?: EmberName;
};

export function buildWidgetSnapshot({
  snapshot,
  now,
  list,
  monthEvents = [],
  habitHistory = {},
  counts,
  window = DEFAULT_DAY_WINDOW,
  ember = DEFAULT_EMBER,
}: BuildWidgetSnapshotInput): WidgetSnapshot {
  const agenda = buildAgenda({
    events: snapshot.events,
    classes: snapshot.classes,
    window: { start: snapshot.dayStart, end: snapshot.dayEnd },
    now,
  });
  // Same rule as the home screen, and deliberately the same function: a widget
  // that disagreed with the app about what is next would be worse than none.
  const upcoming = nextUp(agenda, now);

  const day = buildDay({ snapshot, agenda, upcoming, window });

  return {
    version: WIDGET_SNAPSHOT_VERSION,
    publishedAt: now,
    zone: snapshot.zone,
    ember,
    day,
    month: buildMonth({ snapshot, monthEvents, now }),
    configured: {
      // Falls back to what today happens to hold. Wrong only in the direction
      // that matters least: a user with things but an empty today is told
      // "nothing booked" rather than "nothing set up yet".
      calendar: counts ? counts.events > 0 : snapshot.events.length > 0,
      tasks: counts
        ? counts.tasks > 0
        : snapshot.dueTasks.length + snapshot.overdueTasks.length > 0,
      habits: counts ? counts.habits > 0 : snapshot.habits.length > 0,
      lists: counts ? counts.lists > 0 : list != null,
    },
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
      ages: taskAges(snapshot, now),
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
      rows: [...snapshot.habits]
        // Oldest habit first, for ever. See `WidgetSnapshot.habits.rows`.
        .sort((a, b) => (a.habit.createdAt ?? 0) - (b.habit.createdAt ?? 0))
        .slice(0, ROW_CAP)
        .map((entry) => ({
          name: entry.habit.name,
          doneToday: entry.loggedToday,
          streak: entry.streak,
          longestStreak: entry.habit.longestStreak ?? 0,
          history: historyString(habitHistory[entry.habit.id] ?? [], day.date, snapshot.zone),
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
    // A calendar widget that silently omits all-day events is a bug, not a
    // design gap: "flying to Berlin" is exactly what you want a glance to say.
    allDay: agenda.allDay.slice(0, ALL_DAY_CAP).map((item) => item.title),
    list: list
      ? {
          name: list.name,
          // Both counted before the cap, so "4 of 12" stays true on a long list.
          open: list.rows.filter((row) => !row.done).length,
          total: list.rows.length,
          // Open items first: a shopping list widget is for what is left.
          rows: [...list.rows]
            .sort((a, b) => Number(a.done) - Number(b.done))
            .slice(0, ROW_CAP),
        }
      : null,
  };
}

/* ------------------------------------------------------------------ the day */

type DayInput = {
  snapshot: TodaySnapshot;
  agenda: ReturnType<typeof buildAgenda>;
  upcoming: ReturnType<typeof nextUp>;
  window: { startMinute: number; endMinute: number };
};

function buildDay({ snapshot, agenda, upcoming, window }: DayInput): WidgetDay {
  const startMinute = window.startMinute;
  const cells = Math.max(
    1,
    Math.round((window.endMinute - startMinute) / DAY_CELL_MINUTES),
  );

  const load = new Array<string>(cells).fill(HEAT.cold);
  const breaks = new Array<string>(cells).fill('0');

  // Buffers are a hint about when to leave, carried by `next.leaveAt`. Drawn as
  // claimed time they would book the twenty minutes before every appointment.
  const booked = agenda.timed.filter((item) => item.kind !== 'buffer');

  for (const item of booked) {
    const from = cellOf(item.startsAt, snapshot.dayStart, startMinute, cells);
    // A meeting that ends exactly on a cell boundary does not own that cell.
    const to = cellOf(item.endsAt - 1, snapshot.dayStart, startMinute, cells);
    if (to < 0 || from >= cells) continue;

    const first = Math.max(0, from);
    const last = Math.min(cells - 1, to);
    for (let cell = first; cell <= last; cell++) load[cell] = HEAT.mid;
    // Only when the event genuinely starts inside the window — clamping a 06:00
    // meeting to cell 0 must not draw a boundary the day does not have.
    if (from >= 0 && from < cells) breaks[from] = '1';
  }

  const nextCell =
    upcoming != null
      ? clampCell(cellOf(upcoming.item.startsAt, snapshot.dayStart, startMinute, cells), cells)
      : -1;
  if (nextCell >= 0) load[nextCell] = HEAT.hot;

  return {
    date: snapshot.date,
    startMinute,
    cellMinutes: DAY_CELL_MINUTES,
    load: load.join(''),
    breaks: breaks.join(''),
    nextCell,
    freeMinutes: load.filter((cell) => cell === HEAT.cold).length * DAY_CELL_MINUTES,
  };
}

/**
 * Which cell an instant falls in — negative before the window, `cells` after.
 *
 * Measured from the day's own midnight rather than from a `DateTime`, so this
 * stays pure arithmetic and a DST day is handled by `dayStart` having already
 * absorbed it.
 */
function cellOf(at: number, dayStart: number, startMinute: number, cells: number): number {
  const minutes = (at - dayStart) / 60_000 - startMinute;
  const cell = Math.floor(minutes / DAY_CELL_MINUTES);
  return cell < 0 ? -1 : cell >= cells ? cells : cell;
}

/** Anything outside the window is drawn in the nearest edge cell rather than lost. */
function clampCell(cell: number, cells: number): number {
  return Math.min(cells - 1, Math.max(0, cell));
}

/* ---------------------------------------------------------------- the month */

function buildMonth({
  snapshot,
  monthEvents,
  now,
}: {
  snapshot: TodaySnapshot;
  monthEvents: readonly MonthInterval[];
  now: number;
}): WidgetMonth {
  const zone = snapshot.zone;
  const month = snapshot.date.slice(0, 7);
  const { start } = monthRange(snapshot.dayStart, zone);

  // Boundaries stepped with Luxon rather than by adding 24 hours, because a
  // month containing a DST switch has a 23- or 25-hour day in it and fixed
  // arithmetic would slide every later day an hour into its neighbour.
  const first = DateTime.fromMillis(start, { zone });
  const days = first.daysInMonth ?? 31;
  const edges = Array.from({ length: days + 1 }, (_, index) =>
    first.plus({ days: index }).toMillis(),
  );

  // Minutes booked per day, so the plate can say "busy" rather than "something".
  const minutes = new Array<number>(days).fill(0);
  for (const event of monthEvents) {
    if (event.allDay) {
      // An all-day event claims the day without saying how long it takes. It
      // reads as busy, not as full, or a birthday would outrank a workday.
      const index = dayIndex(event.startsAt, zone, days);
      if (index >= 0) minutes[index] = Math.max(minutes[index]!, 1);
      continue;
    }
    for (let index = 0; index < days; index++) {
      const overlap = Math.min(event.endsAt, edges[index + 1]!) - Math.max(event.startsAt, edges[index]!);
      if (overlap > 0) minutes[index]! += overlap / 60_000;
    }
  }

  const load = minutes
    .map((booked) => (booked === 0 ? HEAT.cold : booked < 120 ? HEAT.low : HEAT.mid))
    .join('');

  const today = localDateOf(now, zone);
  return {
    month,
    weekStartsOn: 1,
    load,
    today: today.slice(0, 7) === month ? Number(today.slice(8, 10)) : 0,
  };
}

/**
 * Days are stepped through by index rather than by adding 24 hours to a clock,
 * because a DST day is 23 or 25 hours long and the shifted one would land in
 * its neighbour.
 */
function dayIndex(at: number, zone: string, days: number): number {
  const index = Number(localDateOf(at, zone).slice(8, 10)) - 1;
  return index >= 0 && index < days ? index : -1;
}

/* ---------------------------------------------------------------- the rails */

/**
 * The last `HABIT_HISTORY_DAYS` days as '0' and '1', ending on `today`.
 *
 * Dates are compared as strings. They are all `YYYY-MM-DD` in the same zone, so
 * that is exact, and it avoids constructing 35 `DateTime`s per habit on every
 * publish — which happens on every data change, for every habit.
 */
function historyString(dates: readonly LocalDate[], today: LocalDate, zone: string): string {
  const logged = new Set(dates);
  const end = Date.parse(`${today}T12:00:00Z`);
  let out = '';
  for (let back = HABIT_HISTORY_DAYS - 1; back >= 0; back--) {
    const date = new Date(end - back * 86_400_000).toISOString().slice(0, 10);
    out += logged.has(date) ? '1' : '0';
  }
  return out;
}

/* ---------------------------------------------------------------- the tasks */

/**
 * How many days late each open task is, oldest first.
 *
 * Age and not due-time, deliberately. The tool contract makes `due` a full
 * `YYYY-MM-DDTHH:mm`, so the model invents an hour whenever the user did not
 * say one — plotting that as a position would render fiction as data. How late
 * something is was never guessed.
 */
function taskAges(snapshot: TodaySnapshot, now: number): number[] {
  const zone = snapshot.zone;
  const today = snapshot.dayStart;
  const ages = snapshot.overdueTasks
    .map((task) => {
      if (task.dueDate == null) return 0;
      return Math.max(1, Math.round((today - startOfDayMs(task.dueDate, zone)) / 86_400_000));
    })
    .sort((a, b) => b - a);
  // Due today is age 0, and there are as many of those as there are tasks.
  const dueToday = new Array<number>(snapshot.dueTasks.length).fill(0);
  void now;
  return [...ages, ...dueToday].slice(0, AGE_CAP);
}

function startOfDayMs(at: number, zone: string): number {
  return Date.parse(`${localDateOf(at, zone)}T00:00:00Z`);
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
    a.zone !== b.zone ||
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

/**
 * Everything the faces draw, minus `publishedAt`, which changes every time.
 *
 * An explicit list, and therefore the one thing in this file that can ship
 * broken in silence: a section left out here publishes once and then never
 * redraws, with nothing failing anywhere. `snapshot.test.ts` asserts that every
 * section of a snapshot is reachable from it.
 */
function digest(snapshot: WidgetSnapshot): string {
  return JSON.stringify([
    // Not a section anything draws, and the one field here that would fail
    // silently in a way nobody would think to look for: pick a new colour and
    // the tiles keep the old one until the next time the day happens to change.
    snapshot.ember,
    snapshot.agenda,
    snapshot.allDay,
    snapshot.tasks.rows,
    snapshot.tasks.ages,
    snapshot.habits.rows,
    snapshot.list,
    snapshot.day,
    snapshot.month,
    snapshot.configured,
  ]);
}
