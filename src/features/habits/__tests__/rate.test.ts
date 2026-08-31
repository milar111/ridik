/**
 * The arithmetic is trivial; the denominator is not. Every test here is really
 * about which days are allowed to count against the user.
 */
import { completionRate, formatRate, summarise } from '../rate';

const week = (start: number): string[] =>
  Array.from({ length: 7 }, (_, i) => `2026-08-${String(start + i).padStart(2, '0')}`);

describe('completionRate', () => {
  it('counts only days that have elapsed, so a perfect record reads 100 mid-week', () => {
    // The bug this exists to prevent: dividing by all seven on a Wednesday
    // makes a flawless habit read 43% and climb all week for no reason.
    const days = week(17); // Mon 17th … Sun 23rd
    const logged = new Set(['2026-08-17', '2026-08-18', '2026-08-19']);

    expect(completionRate(days, logged, '2026-08-19')).toEqual({
      logged: 3,
      elapsed: 3,
      rate: 1,
    });
  });

  it('counts today as losable rather than excusing it', () => {
    // Not yet logged today is genuinely behind. Excluding today until midnight
    // would make the number agree with the user instead of with the record.
    const days = week(17);
    const logged = new Set(['2026-08-17', '2026-08-18']);
    const rate = completionRate(days, logged, '2026-08-19');

    expect(rate.elapsed).toBe(3);
    expect(rate.logged).toBe(2);
  });

  it('ignores a log sitting outside the window', () => {
    const days = week(17);
    const logged = new Set(['2026-08-10', '2026-08-17']);

    expect(completionRate(days, logged, '2026-08-19').logged).toBe(1);
  });

  it('answers zero rather than dividing when nothing has elapsed', () => {
    // Reachable: a window whose first day is still in the future.
    expect(completionRate(week(24), new Set(), '2026-08-19')).toEqual({
      logged: 0,
      elapsed: 0,
      rate: 0,
    });
  });

  it('handles an empty window', () => {
    expect(completionRate([], new Set(), '2026-08-19').rate).toBe(0);
  });
});

describe('summarise', () => {
  it('sums days rather than averaging percentages', () => {
    // A habit added yesterday must not weigh the same as one kept for a month.
    // Averaging the rates here would give (100 + 0) / 2 = 50%; summing the days
    // gives 30 of 31, which is what actually happened.
    const kept = { logged: 30, elapsed: 30, rate: 1 };
    const fresh = { logged: 0, elapsed: 1, rate: 0 };

    const total = summarise([kept, fresh]);
    expect(total).toEqual({ logged: 30, elapsed: 31, rate: 30 / 31 });
    expect(formatRate(total)).toBe('96%');
  });

  it('is zero for no habits at all', () => {
    expect(summarise([])).toEqual({ logged: 0, elapsed: 0, rate: 0 });
  });
});

describe('formatRate', () => {
  it('reserves 100% for a genuinely unbroken record', () => {
    // 34 of 35 is 97.1%, which rounds to 100 at no sane precision — but a naive
    // `Math.round` on a 0.995 rate would print it, and a habit with a missed day
    // claiming a full score is the one number here that would be a lie.
    expect(formatRate({ logged: 34, elapsed: 35, rate: 34 / 35 })).toBe('97%');
    expect(formatRate({ logged: 199, elapsed: 200, rate: 0.995 })).toBe('99%');
    expect(formatRate({ logged: 35, elapsed: 35, rate: 1 })).toBe('100%');
  });

  it('floors rather than rounds up, so the number never flatters', () => {
    expect(formatRate({ logged: 2, elapsed: 3, rate: 2 / 3 })).toBe('66%');
  });

  it('says nothing rather than 0% when there is nothing to report', () => {
    expect(formatRate({ logged: 0, elapsed: 0, rate: 0 })).toBe('—');
  });

  it('says 0% when the window elapsed and nothing was kept', () => {
    expect(formatRate({ logged: 0, elapsed: 5, rate: 0 })).toBe('0%');
  });
});
