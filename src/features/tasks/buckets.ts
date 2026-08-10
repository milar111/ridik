/**
 * Due-date buckets for the active list.
 *
 * Grouping is calendar-based rather than a millisecond offset: "tomorrow" has
 * to mean the next calendar day even when it is only fourteen hours away, which
 * is what a person means when they say it. `calendarDaysBetween` already does
 * that in the user's zone, DST included.
 */
import { now } from '@/core/clock';
import {
  calendarDaysBetween,
  currentZone,
  formatDayHeading,
  formatTime,
  startOfDay,
} from '@/core/time';
import type { Task } from '@/db/schema';

export type DueBucket = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'none';

/** Soonest first; undated last, because "no date" is the least urgent thing. */
export const BUCKET_ORDER: readonly DueBucket[] = [
  'overdue',
  'today',
  'tomorrow',
  'week',
  'later',
  'none',
] as const;

export const BUCKET_LABEL: Record<DueBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  tomorrow: 'Tomorrow',
  week: 'This week',
  later: 'Later',
  none: 'No date',
};

/** Colour here means state, so only the two buckets that demand action get one. */
export type BucketTone = 'danger' | 'warning' | 'neutral';

export const BUCKET_TONE: Record<DueBucket, BucketTone> = {
  overdue: 'danger',
  today: 'warning',
  tomorrow: 'neutral',
  week: 'neutral',
  later: 'neutral',
  none: 'neutral',
};

export function bucketOf(dueDate: number | null | undefined, at: number = now()): DueBucket {
  if (dueDate == null) return 'none';
  const days = calendarDaysBetween(at, dueDate);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 7) return 'week';
  return 'later';
}

export type TaskGroup = { bucket: DueBucket; tasks: Task[] };

/**
 * Buckets in fixed order, empty ones dropped.
 *
 * The incoming order (due, then priority) is preserved inside each group — the
 * repository already sorts, and re-sorting here would silently disagree with it.
 */
export function groupByDueBucket(tasks: readonly Task[], at: number = now()): TaskGroup[] {
  const byBucket = new Map<DueBucket, Task[]>();
  for (const task of tasks) {
    const bucket = bucketOf(task.dueDate, at);
    const existing = byBucket.get(bucket);
    if (existing) existing.push(task);
    else byBucket.set(bucket, [task]);
  }
  return BUCKET_ORDER.flatMap((bucket) => {
    const group = byBucket.get(bucket);
    return group && group.length > 0 ? [{ bucket, tasks: group }] : [];
  });
}

/**
 * "Today", or "Today 14:30" when the user actually picked a time.
 *
 * `at` is threaded through explicitly rather than left to `formatDayHeading`'s
 * `Date.now()` default: the label has to agree with `bucketOf`, and both read
 * the injectable clock so a frozen test sees one consistent "today".
 */
export function dueLabel(dueDate: number, at: number = now()): string {
  const zone = currentZone();
  const day = formatDayHeading(dueDate, zone, at);
  return startOfDay(dueDate, zone) === dueDate ? day : `${day} ${formatTime(dueDate, zone)}`;
}

export const PRIORITY_LABEL: Record<number, string> = { 1: 'High', 2: 'Normal', 3: 'Low' };

export function priorityLabel(priority: number): string {
  return PRIORITY_LABEL[priority] ?? 'Normal';
}
