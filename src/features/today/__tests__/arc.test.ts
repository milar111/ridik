/**
 * The arc's whole job is to not lie about time, so these tests are mostly about
 * position rather than about shape.
 *
 * The first block is the important one: `dayArc.ts` places every marker by
 * treating the curve parameter as the fraction of the day elapsed, which is only
 * legitimate because the control point is centred horizontally. If that ever
 * stops holding — someone gives the curve a lopsided peak to make it prettier —
 * every marker on it silently moves to the wrong time. Nothing about the screen
 * would look broken; the arc would just be wrong, which is worse.
 */
import {
  arcPathTo,
  arcPath,
  arcPointAt,
  clampFraction,
  dayFraction,
  type ArcGeometry,
} from '../arc';

const geometry: ArcGeometry = { width: 300, height: 120, inset: 10 };

describe('the time claim', () => {
  it('spaces x exactly evenly, so t is the fraction of the day', () => {
    // The identity x(t) = x0 + t·(x1 - x0). Sampled rather than asserted at the
    // ends, because a curve can hit both ends correctly and bulge in between.
    const x0 = arcPointAt(0, geometry).x;
    const x1 = arcPointAt(1, geometry).x;
    for (let step = 0; step <= 10; step += 1) {
      const t = step / 10;
      expect(arcPointAt(t, geometry).x).toBeCloseTo(x0 + t * (x1 - x0), 6);
    }
  });

  it('starts and ends on the baseline and peaks at midday', () => {
    const base = geometry.height - geometry.inset;
    expect(arcPointAt(0, geometry).y).toBeCloseTo(base, 6);
    expect(arcPointAt(1, geometry).y).toBeCloseTo(base, 6);
    expect(arcPointAt(0.5, geometry).y).toBeCloseTo(geometry.inset, 6);
  });

  it('is symmetric about midday, so morning and evening read alike', () => {
    for (const t of [0.1, 0.25, 0.4]) {
      expect(arcPointAt(t, geometry).y).toBeCloseTo(arcPointAt(1 - t, geometry).y, 6);
    }
  });

  it('rises monotonically to midday and never doubles back', () => {
    let previous = Infinity;
    for (let step = 0; step <= 50; step += 1) {
      const { y } = arcPointAt(step / 100, geometry);
      expect(y).toBeLessThanOrEqual(previous + 1e-9);
      previous = y;
    }
  });
});

describe('dayFraction', () => {
  const window = { start: 1_000, end: 2_000 };

  it('reports the position of a moment inside the day', () => {
    expect(dayFraction(1_000, window)).toBe(0);
    expect(dayFraction(1_500, window)).toBe(0.5);
    expect(dayFraction(2_000, window)).toBe(1);
  });

  it('clamps rather than running off either end of the curve', () => {
    // Reachable in practice: the snapshot's window is the *local* day, and a
    // screen left open past midnight is asking about a `now` beyond its end.
    expect(dayFraction(500, window)).toBe(0);
    expect(dayFraction(9_999, window)).toBe(1);
  });

  it('answers 0 for a window that cannot be divided by, rather than NaN', () => {
    // A NaN here would put every marker in the top-left corner, which looks
    // deliberate — the worst way for a mid-refresh screen to fail.
    expect(dayFraction(1_500, { start: 1_000, end: 1_000 })).toBe(0);
    expect(dayFraction(1_500, { start: 2_000, end: 1_000 })).toBe(0);
  });
});

describe('clampFraction', () => {
  it('refuses a non-finite fraction instead of propagating it', () => {
    expect(clampFraction(Number.NaN)).toBe(0);
    expect(clampFraction(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('paths', () => {
  it('draws the whole day as a single quadratic', () => {
    // x runs inset..width-inset, so 10..290, and the control sits between them.
    expect(arcPath(geometry)).toBe('M 10 110 Q 150 -90 290 110');
  });

  it('ends the elapsed stroke exactly on the point the marker is placed at', () => {
    // The reason for splitting rather than sampling: if these two disagree the
    // accent stroke and its marker are drawn a fraction of a pixel apart, which
    // reads as a blurred line rather than as a bug anyone would report.
    for (const t of [0, 0.15, 0.5, 0.83, 1]) {
      const point = arcPointAt(t, geometry);
      expect(arcPathTo(t, geometry)).toContain(`${round(point.x)} ${round(point.y)}`);
    }
  });

  it('collapses to a degenerate path at the start of the day', () => {
    // Not a crash and not a full-width stroke: nothing of the day has elapsed.
    expect(arcPathTo(0, geometry)).toBe('M 10 110 Q 10 110 10 110');
  });

  it('survives a geometry with no room in it', () => {
    // `inset` larger than the box is reachable from a narrow phone in a large
    // font size; it must degenerate rather than produce NaN in a path string.
    const path = arcPath({ width: 8, height: 8, inset: 10 });
    expect(path).not.toContain('NaN');
  });
});

const round = (value: number): string => String(Math.round(value * 1000) / 1000);
