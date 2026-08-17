/**
 * When the daily briefing fires, and the single place that books it.
 *
 * The maths at the top is pure and stays importable under plain Node, which is
 * what lets a test walk it across a DST boundary. Everything OS-facing below it
 * loads its dependencies at call time so importing this module never drags in
 * expo-notifications or the database.
 */
import type { Logger } from '@/core/logger';
import { countLabel, joinNatural } from '@/core/format';
import { err, ok, toAppError, type Result } from '@/core/result';
import { DateTime, formatSpokenTime } from '@/core/time';

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
 * Clears any briefing the OS is still holding.
 *
 * The briefing used to be a notification you scheduled for an hour of your
 * choosing. It is not any more: it is shown once, on the first time you open
 * the app on a given day, so there is nothing left to book — only the copies an
 * earlier version of the app queued, which have to be taken back or they will
 * keep arriving for a week.
 *
 * Kept as a startup step rather than a one-off migration because a notification
 * can be re-queued by a background task that was already in flight when the
 * update landed.
 */
export async function cancelScheduledBriefing(): Promise<Result<BriefingSchedule>> {
  let log: Logger | null = null;
  try {
    const runtime = await loadRuntime();
    log = runtime.log;
    await runtime.notifications.cancelForEntity(BRIEFING_ENTITY_ID);
    return ok({ scheduled: false, at: null, notificationId: null, summary: null });
  } catch (error) {
    log?.warn('could not clear the queued briefing', error);
    return err(toAppError(error, 'Could not clear the queued briefing.'));
  }
}

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
