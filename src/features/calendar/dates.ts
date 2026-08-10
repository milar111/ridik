/**
 * Week and month arithmetic for the calendar screen.
 *
 * This is screen geometry rather than storage semantics, so it lives beside the
 * screen instead of in '@/core/time' — but every conversion still goes through
 * that module, so the strip can never drift from the agenda by a DST hour.
 */
import { calendarDaysBetween, dayRange, epochToLocal, localDateOf, type LocalDate } from '@/core/time';

export const DAYS_IN_WEEK = 7;
/** Six rows of seven: the only grid that fits every month in every locale. */
export const MONTH_GRID_CELLS = 42;

export type WeekStart = 0 | 1;

/** Local midnight that opens the week `epoch` falls in. */
export function startOfWeek(epoch: number, zone: string, weekStartsOn: WeekStart = 1): number {
  const day = epochToLocal(epoch, zone).startOf('day');
  if (weekStartsOn === 1) return day.startOf('week').toMillis();
  // Luxon has no Sunday-start week: for Mon–Sat the Sunday-start week opens the
  // day before luxon's Monday, and a Sunday already *is* its own week start.
  return day.weekday === 7 ? day.toMillis() : day.startOf('week').minus({ days: 1 }).toMillis();
}

export function addWeeks(epoch: number, weeks: number, zone: string): number {
  return epochToLocal(epoch, zone).plus({ weeks }).startOf('day').toMillis();
}

export function addMonths(epoch: number, months: number, zone: string): number {
  return epochToLocal(epoch, zone).plus({ months }).startOf('day').toMillis();
}

/** Whole weeks from `from` to `to`, rounded — both are week starts in practice. */
export function weeksBetween(from: number, to: number, zone: string): number {
  return Math.round(calendarDaysBetween(from, to, zone) / DAYS_IN_WEEK);
}

export function weekDates(weekStart: number, zone: string): LocalDate[] {
  const first = epochToLocal(weekStart, zone).startOf('day');
  return Array.from({ length: DAYS_IN_WEEK }, (_, i) =>
    localDateOf(first.plus({ days: i }).toMillis(), zone),
  );
}

/** Local midnight of a `YYYY-MM-DD`, which is what every range query wants. */
export function epochOfDate(date: LocalDate, zone: string): number {
  return dayRange(date, zone).start;
}

export function dayNumberOf(date: LocalDate, zone: string): number {
  return epochToLocal(epochOfDate(date, zone), zone).day;
}

export function isWeekend(date: LocalDate, zone: string): boolean {
  const weekday = epochToLocal(epochOfDate(date, zone), zone).weekday;
  return weekday === 6 || weekday === 7;
}

/** Monday-based 0..6, which is how `weekdayInitials(1)` is indexed. */
export function weekdayIndexOf(date: LocalDate, zone: string): number {
  return epochToLocal(epochOfDate(date, zone), zone).weekday - 1;
}

export function isSameMonth(date: LocalDate, anchor: number, zone: string): boolean {
  const a = epochToLocal(epochOfDate(date, zone), zone);
  const b = epochToLocal(anchor, zone);
  return a.year === b.year && a.month === b.month;
}

/** 42 dates covering the month `anchor` falls in, padded to whole weeks. */
export function monthGrid(anchor: number, zone: string, weekStartsOn: WeekStart = 1): LocalDate[] {
  const monthStart = epochToLocal(anchor, zone).startOf('month').toMillis();
  const gridStart = epochToLocal(startOfWeek(monthStart, zone, weekStartsOn), zone).startOf('day');
  return Array.from({ length: MONTH_GRID_CELLS }, (_, i) =>
    localDateOf(gridStart.plus({ days: i }).toMillis(), zone),
  );
}

/**
 * Month name and year, e.g. "August 2026". Hand-rolled because '@/core/time'
 * exposes no month-only formatter and is not ours to extend.
 */
export function formatMonthLabel(epoch: number, zone: string): string {
  return epochToLocal(epoch, zone).toFormat('LLLL yyyy');
}

/** The month a week belongs to is the one holding its midpoint, not its Monday. */
export function monthOfWeek(weekStart: number, zone: string): number {
  return epochToLocal(weekStart, zone).plus({ days: 3 }).toMillis();
}

const MONDAY_FIRST = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;
const SUNDAY_FIRST = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;

export function weekdayInitials(weekStartsOn: WeekStart = 1): readonly string[] {
  return weekStartsOn === 1 ? MONDAY_FIRST : SUNDAY_FIRST;
}
