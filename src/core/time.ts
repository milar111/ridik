/**
 * Time discipline for the whole app.
 *
 * Rule: every timestamp that crosses a storage or API boundary is UTC epoch
 * milliseconds. Wall-clock strings only exist at two edges — what the LLM emits
 * and what we render. Conversion always happens through a named IANA zone so a
 * DST transition can never shift a stored instant.
 */
import { DateTime, Duration, Interval } from 'luxon';

/** `YYYY-MM-DD` */
export type LocalDate = string;
/** `YYYY-MM-DDTHH:mm` or `YYYY-MM-DDTHH:mm:ss` — wall clock, no offset. */
export type LocalDateTime = string;

export const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;
export const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

let zoneOverride: string | null = null;

/** The user's IANA zone. Overridable for tests and for a manual setting. */
export function currentZone(): string {
  return zoneOverride ?? DateTime.local().zoneName ?? 'UTC';
}

export function setZoneOverride(zone: string | null): void {
  zoneOverride = zone;
}

export function isValidZone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid;
}

/* ---------------------------------------------------------------- parsing -- */

/**
 * Resolves a wall-clock string in a zone to UTC epoch ms.
 *
 * Ambiguous local times (the hour repeated when clocks go back) resolve to the
 * *first* occurrence; non-existent times (the hour skipped when clocks go
 * forward) are pushed forward by luxon rather than throwing, matching what a
 * human means when they say "09:30 on the switchover day".
 */
export function localToEpoch(local: LocalDateTime | LocalDate, zone = currentZone()): number {
  const normalised = local.includes('T') || local.includes(' ') ? local.replace(' ', 'T') : `${local}T00:00`;
  const dt = DateTime.fromISO(normalised, { zone });
  if (!dt.isValid) throw new Error(`Invalid local datetime "${local}" for zone "${zone}"`);
  return dt.toMillis();
}

/** Accepts wall-clock strings and absolute ISO strings (with Z/offset) alike. */
export function anyToEpoch(value: string, zone = currentZone()): number {
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const dt = hasOffset ? DateTime.fromISO(value) : DateTime.fromISO(value.replace(' ', 'T'), { zone });
  if (!dt.isValid) throw new Error(`Invalid datetime "${value}"`);
  return dt.toMillis();
}

export function epochToLocal(epoch: number, zone = currentZone()): DateTime {
  return DateTime.fromMillis(epoch, { zone });
}

export function localDateOf(epoch: number, zone = currentZone()): LocalDate {
  return epochToLocal(epoch, zone).toISODate()!;
}

export function todayLocalDate(zone = currentZone(), now = Date.now()): LocalDate {
  return localDateOf(now, zone);
}

/* ------------------------------------------------------------- formatting -- */

export function formatTime(epoch: number, zone = currentZone()): string {
  return epochToLocal(epoch, zone).toFormat('HH:mm');
}

/** "9:30 AM" style, for spoken briefings. */
export function formatSpokenTime(epoch: number, zone = currentZone()): string {
  const dt = epochToLocal(epoch, zone);
  return dt.minute === 0 ? dt.toFormat('h a') : dt.toFormat('h:mm a');
}

export function formatDateTime(epoch: number, zone = currentZone()): string {
  return epochToLocal(epoch, zone).toFormat('ccc d LLL, HH:mm');
}

export function formatDayHeading(epoch: number, zone = currentZone(), now = Date.now()): string {
  const dt = epochToLocal(epoch, zone).startOf('day');
  const today = epochToLocal(now, zone).startOf('day');
  const diff = dt.diff(today, 'days').days;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return dt.toFormat(Math.abs(diff) < 300 ? 'cccc d LLLL' : 'cccc d LLLL yyyy');
}

export function formatRelative(epoch: number, now = Date.now()): string {
  return DateTime.fromMillis(epoch).toRelative({ base: DateTime.fromMillis(now) }) ?? '';
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const dur = Duration.fromObject({ minutes }).shiftTo('hours', 'minutes');
  const h = Math.floor(dur.hours);
  const m = Math.round(dur.minutes);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/* ----------------------------------------------------------------- ranges -- */

export function dayRange(date: LocalDate, zone = currentZone()): { start: number; end: number } {
  const start = DateTime.fromISO(date, { zone }).startOf('day');
  if (!start.isValid) throw new Error(`Invalid date "${date}"`);
  return { start: start.toMillis(), end: start.plus({ days: 1 }).toMillis() };
}

export function weekRange(
  epoch = Date.now(),
  zone = currentZone(),
): { start: number; end: number } {
  const start = DateTime.fromMillis(epoch, { zone }).startOf('week');
  return { start: start.toMillis(), end: start.plus({ weeks: 1 }).toMillis() };
}

export function monthRange(
  epoch = Date.now(),
  zone = currentZone(),
): { start: number; end: number } {
  const start = DateTime.fromMillis(epoch, { zone }).startOf('month');
  return { start: start.toMillis(), end: start.plus({ months: 1 }).toMillis() };
}

export function overlaps(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && b.start < a.end;
}

export function intervalOf(start: number, end: number): Interval {
  return Interval.fromDateTimes(DateTime.fromMillis(start), DateTime.fromMillis(end));
}

/* ------------------------------------------------------------- curriculum -- */

/** Luxon weekdays are 1=Mon..7=Sun; the schema uses 0=Sun..6=Sat. */
export function luxonWeekdayToSchema(weekday: number): number {
  return weekday % 7;
}

export function schemaDayToLuxonWeekday(day: number): number {
  return day === 0 ? 7 : day;
}

/**
 * Next occurrence of a weekly slot at or after `from`, honouring odd/even week
 * parity (ISO week number) so bi-weekly timetables resolve correctly.
 */
export function nextWeeklyOccurrence(
  dayOfWeek: number,
  timeOfDay: string,
  options: { from?: number; zone?: string; parity?: 'every' | 'odd' | 'even' } = {},
): number {
  const zone = options.zone ?? currentZone();
  const from = options.from ?? Date.now();
  const parity = options.parity ?? 'every';
  const parts = timeOfDay.split(':');
  const hour = Number(parts[0] ?? 0);
  const minute = Number(parts[1] ?? 0);

  let cursor = DateTime.fromMillis(from, { zone }).set({
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });
  const targetWeekday = schemaDayToLuxonWeekday(dayOfWeek);

  for (let i = 0; i < 60; i++) {
    if (
      cursor.weekday === targetWeekday &&
      cursor.toMillis() >= from &&
      matchesParity(cursor.weekNumber, parity)
    ) {
      return cursor.toMillis();
    }
    cursor = cursor.plus({ days: 1 }).set({ hour, minute, second: 0, millisecond: 0 });
  }
  throw new Error('No matching weekly occurrence within 60 days');
}

function matchesParity(weekNumber: number, parity: 'every' | 'odd' | 'even'): boolean {
  if (parity === 'every') return true;
  return parity === 'odd' ? weekNumber % 2 === 1 : weekNumber % 2 === 0;
}

export function addMinutes(epoch: number, minutes: number): number {
  return epoch + minutes * 60_000;
}

export function startOfDay(epoch: number, zone = currentZone()): number {
  return DateTime.fromMillis(epoch, { zone }).startOf('day').toMillis();
}

export function endOfDay(epoch: number, zone = currentZone()): number {
  return DateTime.fromMillis(epoch, { zone }).endOf('day').toMillis();
}

/** Difference in whole calendar days in the given zone (DST-safe). */
export function calendarDaysBetween(a: number, b: number, zone = currentZone()): number {
  const da = DateTime.fromMillis(a, { zone }).startOf('day');
  const db = DateTime.fromMillis(b, { zone }).startOf('day');
  return Math.round(db.diff(da, 'days').days);
}

export function isSameLocalDay(a: number, b: number, zone = currentZone()): boolean {
  return calendarDaysBetween(a, b, zone) === 0;
}

export { DateTime, Duration, Interval };
