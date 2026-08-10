/**
 * When the daily briefing fires, and the single place that books it.
 *
 * The maths at the top is pure and stays importable under plain Node, which is
 * what lets a test walk it across a DST boundary. Everything OS-facing below it
 * loads its dependencies at call time so importing this module never drags in
 * expo-notifications or the database.
 */
import { now } from '@/core/clock';
import type { Logger } from '@/core/logger';
import { countLabel, joinNatural } from '@/core/format';
import { fail, ok, type Result } from '@/core/result';
import {
  DateTime,
  currentZone,
  dayRange,
  formatSpokenTime,
  isValidZone,
  localDateOf,
} from '@/core/time';
import type { Repositories } from '@/repositories';

/**
 * Every briefing notification carries this entity id, which is how the next
 * scheduling run finds the previous one and cancels it. Two briefings queued
 * for the same morning is the failure mode this guards against.
 */
export const BRIEFING_ENTITY_ID = 'briefing';
export const BRIEFING_TITLE = 'Your day';
export const BRIEFING_HREF = '/briefing';

/** Mirrors the `briefingHour` setting's default; used only for nonsense input. */
const FALLBACK_HOUR = 7;

export type NextBriefingInput = {
  /** UTC epoch ms. */
  now: number;
  /** IANA zone name. */
  zone: string;
  /** Local hour of day, 0-23. */
  hour: number;
  enabled: boolean;
};

/**
 * The next local occurrence of the briefing hour as UTC epoch ms, or null when
 * briefings are switched off.
 *
 * Local-hour arithmetic, not `+ 24h`: on the two DST days of the year the gap
 * between consecutive briefings is 23 or 25 hours, and a user who asked for 07:00
 * means 07:00 on the clock in front of them.
 */
export function nextBriefingAt(input: NextBriefingInput): number | null {
  if (!input.enabled) return null;

  const hour = clampHour(input.hour);
  const zoned = DateTime.fromMillis(input.now, { zone: input.zone });
  // A zone the settings row got wrong must not silently stop the briefing
  // forever; the device's own zone is a better answer than none.
  const base = zoned.isValid ? zoned : DateTime.fromMillis(input.now);

  const today = atHour(base, hour);
  // Strictly after: at the exact instant the briefing fires, the *next* one is
  // tomorrow's, not a second copy of the one being delivered.
  if (today > input.now) return today;
  return atHour(base.plus({ days: 1 }).startOf('day'), hour);
}

function clampHour(hour: number): number {
  if (!Number.isFinite(hour)) return FALLBACK_HOUR;
  return Math.min(23, Math.max(0, Math.trunc(hour)));
}

/**
 * luxon resolves a wall-clock time that DST skipped by rolling forward into the
 * hour that does exist, so a 02:00 briefing on a spring-forward morning fires at
 * 03:00 rather than never.
 */
function atHour(dt: DateTime, hour: number): number {
  return dt.set({ hour, minute: 0, second: 0, millisecond: 0 }).toMillis();
}

export type DaySummary = {
  /** Real events only — a travel buffer is not something to announce. */
  events: number;
  /** Incomplete, unblocked tasks due by end of that day, overdue ones included. */
  tasksDue: number;
  /** UTC epoch ms of the first event that still lies ahead of the briefing. */
  firstEventAt: number | null;
  zone: string;
};

/**
 * The notification body. A briefing that is never opened should still have told
 * the user what kind of day it is, so the counts go in the body rather than
 * behind a tap.
 */
export function briefingBody(summary: DaySummary): string {
  const parts: string[] = [];
  if (summary.events > 0) parts.push(countLabel(summary.events, 'event'));
  if (summary.tasksDue > 0) parts.push(`${countLabel(summary.tasksDue, 'task')} due`);

  if (parts.length === 0) return 'Nothing on the calendar and nothing due. A clear day.';

  const head = `${joinNatural(parts)} today.`;
  if (summary.firstEventAt === null) return head;
  return `${head} First at ${formatSpokenTime(summary.firstEventAt, summary.zone)}.`;
}

export type BriefingSchedule = {
  scheduled: boolean;
  /** UTC epoch ms the briefing will fire at; null when briefings are off. */
  at: number | null;
  notificationId: string | null;
  summary: DaySummary | null;
};

/**
 * Cancels whatever briefing was queued and books exactly one replacement.
 *
 * Called at startup and again after every background run, which is also how the
 * body stays roughly current: the counts are a snapshot taken when the
 * notification is booked, not when it is delivered.
 */
export async function scheduleNextBriefing(): Promise<Result<BriefingSchedule>> {
  // Hoisted so the catch can explain itself: the runtime load is itself one of
  // the things that can fail here.
  let log: Logger | null = null;
  try {
    const runtime = await loadRuntime();
    const { notifications, repos } = runtime;
    log = runtime.log;

    // Unconditional, and before the enabled check: switching briefings off has
    // to clear the copy already sitting in the OS queue.
    await notifications.cancelForEntity(BRIEFING_ENTITY_ID);

    const settings = await repos.settings.getAll();
    const zone = isValidZone(settings.timezone) ? settings.timezone : currentZone();
    const at = nextBriefingAt({
      now: now(),
      zone,
      hour: settings.briefingHour,
      enabled: settings.briefingEnabled,
    });
    if (at === null) {
      return ok({ scheduled: false, at: null, notificationId: null, summary: null });
    }

    const summary = await summariseDay(repos, at, zone, log);
    const scheduled = await notifications.scheduleAt({
      title: BRIEFING_TITLE,
      body: briefingBody(summary),
      at,
      channel: notifications.CHANNELS.briefing,
      data: { kind: 'briefing', entityId: BRIEFING_ENTITY_ID, href: BRIEFING_HREF },
    });
    if (!scheduled.ok) return scheduled;

    log.info('briefing scheduled', { at, events: summary.events, tasksDue: summary.tasksDue });
    return ok({ scheduled: true, at, notificationId: scheduled.value, summary });
  } catch (error) {
    // Keep the cause in the log: without it this reads as an unexplained
    // failure in the diagnostics view, which is where a user would look first.
    log?.warn('briefing scheduling threw', error);
    return fail('unknown', 'Could not schedule the daily briefing.', { cause: error });
  }
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

/**
 * Loaded lazily rather than imported: the scheduling maths above has to stay
 * usable in plain Node, and every one of these reaches for something only the
 * device has (expo-notifications, SQLite, Metro's `__DEV__`).
 */
async function loadRuntime() {
  const [notifications, repositories, logger] = await Promise.all([
    import('@/services/notifications'),
    import('@/repositories'),
    import('@/core/logger'),
  ]);
  return {
    notifications,
    repos: repositories.getRepositories(),
    log: logger.createLogger('briefing'),
  };
}

/** Counts for the day the briefing lands on, never for "today". */
async function summariseDay(
  repos: Repositories,
  at: number,
  zone: string,
  log: Runtime['log'],
): Promise<DaySummary> {
  try {
    const { start, end } = dayRange(localDateOf(at, zone), zone);
    const [events, tasks] = await Promise.all([
      repos.calendar.listBetween(start, end),
      repos.tasks.listActiveTasks({ dueBefore: end }),
    ]);
    const real = events.filter((event) => event.kind !== 'buffer');
    // The earliest event of the day may already be over by the time the
    // briefing lands (or may have started the night before); announcing a start
    // time in the past is worse than announcing none.
    const ahead = real.find((event) => event.startsAt >= at);
    return {
      events: real.length,
      tasksDue: tasks.length,
      firstEventAt: ahead?.startsAt ?? null,
      zone,
    };
  } catch (error) {
    // A broken query is no reason to skip the briefing; a bodiless one still
    // gets the user to open the app.
    log.warn('day summary unavailable', error);
    return { events: 0, tasksDue: 0, firstEventAt: null, zone };
  }
}
