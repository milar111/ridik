/**
 * How much of a habit's window was actually kept.
 *
 * Adopted from the `clay` direction, which put a percentage on each habit and a
 * count under the set. The grid on the Habits screen has always *contained* this
 * number — 35 cells, some filled — but reading it means counting squares, which
 * is exactly the arithmetic a summary is for.
 *
 * Pure, so the one judgement call in it can be tested rather than eyeballed.
 *
 * ## The judgement call: elapsed days, not window days
 *
 * The grid spans five whole weeks, and the last of them has not happened yet.
 * Divide by every cell in the window and a habit kept *perfectly* reads 71% on a
 * Sunday and climbs all week for no reason — the denominator is counting days
 * the user has not had the chance to fail. Worse, the number would be lowest at
 * the start of a week, which is precisely when the encouragement matters.
 *
 * So the denominator is the days that have *elapsed*: everything up to and
 * including today. Today counts, because today is losable — a habit not yet
 * logged today is genuinely behind, and hiding that until midnight would make
 * the number agree with the user rather than with the record.
 */

/** A `LocalDate` is a `YYYY-MM-DD` string, so lexicographic order is date order. */
export type HabitRate = {
  /** Days logged within the elapsed part of the window. */
  logged: number;
  /** Days of the window that have happened, today included. */
  elapsed: number;
  /** `logged / elapsed`, or 0 when nothing has elapsed. `[0, 1]`. */
  rate: number;
};

export function completionRate(
  days: readonly string[],
  logged: ReadonlySet<string>,
  today: string,
): HabitRate {
  let elapsed = 0;
  let hits = 0;
  for (const day of days) {
    // Lexicographic on `YYYY-MM-DD` is chronological, which is the whole reason
    // this app keeps local dates as strings rather than parsing them to compare.
    if (day > today) continue;
    elapsed += 1;
    if (logged.has(day)) hits += 1;
  }
  return { logged: hits, elapsed, rate: elapsed === 0 ? 0 : hits / elapsed };
}

/**
 * The set as one line: "18 of 24 days · 75%".
 *
 * Summed across habits rather than averaged over their percentages. Averaging
 * would weight a habit added yesterday the same as one kept for a month, so a
 * single new habit at 0% could drag a flawless month below half.
 */
export function summarise(rates: readonly HabitRate[]): HabitRate {
  let logged = 0;
  let elapsed = 0;
  for (const rate of rates) {
    logged += rate.logged;
    elapsed += rate.elapsed;
  }
  return { logged, elapsed, rate: elapsed === 0 ? 0 : logged / elapsed };
}

/**
 * The percentage as it is written on screen.
 *
 * Rounded toward zero below 100 so nothing but a perfect record can *say* 100:
 * 34 of 35 days rounds to 100% at one decimal place, and a habit with a missed
 * day claiming a full score is the one number here that would be a lie.
 */
export function formatRate(rate: HabitRate): string {
  if (rate.elapsed === 0) return '—';
  if (rate.logged >= rate.elapsed) return '100%';
  return `${Math.floor(rate.rate * 100)}%`;
}
