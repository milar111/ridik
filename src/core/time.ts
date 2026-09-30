/**
 * Time discipline for the whole app.
 *
 * Rule: every timestamp that crosses a storage or API boundary is UTC epoch
 * milliseconds. Wall-clock strings only exist at two edges — what the LLM emits
 * and what we render. Conversion always happens through a named IANA zone so a
 * DST transition can never shift a stored instant.
 */
import { DateTime, Duration, Interval } from 'luxon';

// The injectable clock, not `Date.now()`. `clock.ts` imports nothing, so this
// cannot be a cycle. See the two defaults below.
import { now as readClock } from './clock';

/** `YYYY-MM-DD` */
export type LocalDate = string;
/** `YYYY-MM-DDTHH:mm` or `YYYY-MM-DDTHH:mm:ss` — wall clock, no offset. */
export type LocalDateTime = string;

export const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;
export const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

let zoneOverride: string | null = null;

/**
 * Twelve-hour or twenty-four, and why it is module state next to the zone.
 *
 * `HH:mm` was hard-coded at every render edge, so an American install read
 * "21:00" on a phone whose own status bar said 9:41 PM — and the *widgets* had
 * been getting this right all along (`DateFormat.is24HourFormat`, and the
 * `ridik_rows_ampm` layout variant that exists for exactly this), which made
 * the tile and the app that published it disagree about the same event.
 *
 * Three values, not a boolean. `auto` reads the device, and the device is not
 * always readable: `Intl` resolves from the *locale*, which on iOS does carry
 * the 24-Hour Time switch (it appends `-u-hc-h23`) and on Android does not —
 * `Locale.getDefault()` knows nothing about that system toggle. So auto is a
 * good default and a bad promise, which is the whole argument for `12h` and
 * `24h` being sayable out loud on the Settings screen rather than inferred.
 *
 * It lives here, beside `zoneOverride`, because it has the same shape of bug:
 * a setting that is read at every render but written once, so applying it only
 * at bootstrap means changing it does nothing until the process is killed.
 * `useSettings.ts` applies both on the write.
 */
export type ClockFormat = 'auto' | '12h' | '24h';

/**
 * The *resolved* answer, not the choice — `null` until something has applied
 * one, which is the only state that asks the device.
 *
 * Resolving `auto` on every call would make `formatTime` read ambient locale
 * at every render, which is the same untestability `now()` exists to prevent:
 * under Node the suite's own locale is en-US, so half the app would render
 * 12-hour in tests and 24 on the phone that wrote the expectations. `auto` is
 * a question asked once, when the setting is applied.
 */
let twelveHour: boolean | null = null;

export function setClockFormat(format: ClockFormat): void {
  twelveHour = format === 'auto' ? deviceUses12Hour() : format === '12h';
}

/** What the device's own locale says, or 24-hour if it will not say. */
function deviceUses12Hour(): boolean {
  try {
    const probe = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(
      new Date(Date.UTC(2020, 0, 1, 13)),
    );
    return /[ap]\.?\s?m/i.test(probe);
  } catch {
    // No full-ICU build. 24-hour is the safer miss: it is unambiguous, where a
    // wrong AM/PM is a meeting read twelve hours out.
    return false;
  }
}

export function uses12Hour(): boolean {
  return twelveHour ?? deviceUses12Hour();
}

/**
 * The width a clock column has to reserve, in points.
 *
 * Measured in the face these columns are actually set in — `mono`, Martian
 * Mono at 13, which is monospaced, so this is arithmetic rather than an
 * estimate: `21:00` is 45.0pt and `12:00 AM` is 72.0pt. The 46 the agenda
 * gutters were built for fits the first with a point to spare and the second
 * not at all, and the failure is not a truncation — a `Text` with room for
 * one line and content for two *wraps*, so every afternoon row in the Today
 * agenda came out as "3:00" over "PM" and the day stopped reading as a list.
 *
 * The tracking is −0.2, which would take 8 characters down to 70.4 — but
 * `AGENTS.md` records that Android does not count `letterSpacing` when it
 * measures a line, so the number that has to fit is the untracked 72.
 *
 * A first version of this used 64, from a measurement taken in Bricolage by
 * mistake. It typechecked, it passed, and it wrapped on the first device it
 * was put on. Measure in the face the text is set in.
 */
export function clockColumnWidth(): number {
  return uses12Hour() ? 74 : 46;
}

/** The three choices, in the order the Settings screen offers them. */
export function clockFormatOptions(): { value: ClockFormat; label: string }[] {
  return [
    { value: 'auto', label: 'Match this phone' },
    { value: '24h', label: '24-hour' },
    { value: '12h', label: '12-hour' },
  ];
}

/**
 * One instant rendered the way a given choice would render it.
 *
 * The Settings row shows this instead of a description: "12-hour" is a
 * specification and `9:41 PM` is the answer, and for `auto` it is the only
 * honest label there is — the row cannot promise which one the device will
 * say, but it can show what it *is* saying.
 */
export function sampleClock(format: ClockFormat, epoch: number, zone = currentZone()): string {
  const twelve = format === 'auto' ? deviceUses12Hour() : format === '12h';
  return epochToLocal(epoch, zone).toFormat(twelve ? 'h:mm a' : 'HH:mm');
}

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
  return epochToLocal(epoch, zone).toFormat(uses12Hour() ? 'h:mm a' : 'HH:mm');
}

/** "9:30 AM" style, for spoken briefings. */
export function formatSpokenTime(epoch: number, zone = currentZone()): string {
  const dt = epochToLocal(epoch, zone);
  return dt.minute === 0 ? dt.toFormat('h a') : dt.toFormat('h:mm a');
}

export function formatDateTime(epoch: number, zone = currentZone()): string {
  return epochToLocal(epoch, zone).toFormat(uses12Hour() ? 'ccc d LLL, h:mm a' : 'ccc d LLL, HH:mm');
}

/*
 * These two default to `now()` rather than `Date.now()`: a module that reads
 * the wall clock directly cannot be frozen, so the string it renders would be
 * whatever the machine running the test happened to say.
 *
 * The parameter stays, because a caller with a `useNow()` tick should keep
 * passing it: that is what re-renders the label as time moves, and a default
 * cannot do it.
 */
export function formatDayHeading(epoch: number, zone = currentZone(), now = readClock()): string {
  const dt = epochToLocal(epoch, zone).startOf('day');
  const today = epochToLocal(now, zone).startOf('day');
  const diff = dt.diff(today, 'days').days;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return dt.toFormat(Math.abs(diff) < 300 ? 'cccc d LLLL' : 'cccc d LLLL yyyy');
}

export function formatRelative(epoch: number, now = readClock()): string {
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
