/**
 * The handful of dates the task UI can set with one tap.
 *
 * Day arithmetic goes through luxon in the user's zone rather than adding
 * 86_400_000, so "tomorrow" survives a DST switch instead of landing at 23:00
 * of the same day.
 */
import { now } from '@/core/clock';
import { currentZone, DateTime } from '@/core/time';

/** Where a task lands when the user gives a day but no time. */
export const DEFAULT_DUE_HOUR = 9;

export function dayAtDefaultHour(offsetDays: number, at: number = now()): number {
  return DateTime.fromMillis(at, { zone: currentZone() })
    .plus({ days: offsetDays })
    .set({ hour: DEFAULT_DUE_HOUR, minute: 0, second: 0, millisecond: 0 })
    .toMillis();
}

/**
 * Tomorrow, keeping the time of day the task already carried.
 *
 * Snoozing a 07:00 alarm-ish task to 09:00 would quietly reschedule it, so the
 * existing wall-clock time wins and only the date moves.
 */
export function snoozeToTomorrow(current: number | null | undefined, at: number = now()): number {
  const zone = currentZone();
  const tomorrow = DateTime.fromMillis(at, { zone }).plus({ days: 1 });
  if (current == null) {
    return tomorrow.set({ hour: DEFAULT_DUE_HOUR, minute: 0, second: 0, millisecond: 0 }).toMillis();
  }
  const existing = DateTime.fromMillis(current, { zone });
  return tomorrow
    .set({ hour: existing.hour, minute: existing.minute, second: 0, millisecond: 0 })
    .toMillis();
}

export const ESTIMATE_CHOICES = [15, 30, 60, 120] as const;
