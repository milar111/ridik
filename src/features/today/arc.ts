/**
 * The day as an arc, and where on it a given moment sits.
 *
 * Adopted from the `horizon` design direction: the day is a curve rising from
 * dawn to a midday peak and back down, `now` is a filled marker on it, and the
 * next thing is a hollow one further along. The arc says two things a list
 * cannot — how much of the day is *behind* you, and how far the next thing is —
 * and it says them at a glance, which is the only budget a screen like this has.
 *
 * Pure and native-free, like `agenda.ts` beside it: the geometry is arithmetic
 * on numbers, so it can be tested under plain Node rather than by looking at it.
 *
 * ## Why a quadratic curve, and why its control point is centred
 *
 * The one thing this component must not do is lie about time. Hang a marker off
 * a curve and you have made a claim: *this* far along the day. A cubic Bézier —
 * which is what the design page drew — cannot honour that claim cheaply, because
 * its parameter `t` is not proportional to horizontal distance, so placing a
 * marker at 14:00 means numerically inverting x(t) first.
 *
 * A **quadratic** curve whose control point sits at the horizontal midpoint
 * makes the problem disappear. Expand x(t) with `cx = (x0 + x1) / 2`:
 *
 *     x(t) = (1-t)²·x0 + 2t(1-t)·cx + t²·x1  =  x0 + t·(x1 - x0)
 *
 * The quadratic terms cancel exactly: **x is linear in t**, so `t` *is* the
 * fraction of the day elapsed, with no inversion and no approximation. y then
 * falls out as `base - 4A·t(1-t)` — a parabola, peaking at `A` at midday.
 *
 * That identity is what `arcPointAt` relies on, and
 * `__tests__/arc.test.ts` asserts it directly rather than trusting the
 * algebra above.
 */

/** The box the arc is drawn in, in SVG user units. */
export type ArcGeometry = {
  width: number;
  height: number;
  /**
   * Room kept on all four sides for the stroke's own width and for a marker
   * sitting on the line. Without it the curve is clipped at the peak and at
   * both feet, which reads as a rendering bug rather than as a tight layout.
   */
  inset: number;
};

export type ArcPoint = { x: number; y: number };

/** `[0, 1]`, because a marker off the end of the curve is worse than one at it. */
export function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * How far through the window a moment is.
 *
 * A zero-length or inverted window answers 0 rather than dividing: the caller is
 * a screen mid-refresh, and `NaN` would place every marker at the top-left
 * corner, which looks deliberate and is the worst way for this to fail.
 */
export function dayFraction(at: number, window: { start: number; end: number }): number {
  const span = window.end - window.start;
  if (!(span > 0)) return 0;
  return clampFraction((at - window.start) / span);
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The curve's three control points; `cx` centred is what makes `t` linear in x. */
function controls(geometry: ArcGeometry) {
  const { width, height, inset } = geometry;
  const x0 = inset;
  const x1 = Math.max(inset, width - inset);
  const base = Math.max(inset, height - inset);
  // Doubled because a quadratic curve only reaches half way to its control
  // point: to peak `amplitude` above the baseline it must aim for twice that.
  const amplitude = Math.max(0, base - inset);
  return { x0, x1, base, cx: (x0 + x1) / 2, cy: base - 2 * amplitude, amplitude };
}

/** Where a fraction of the day sits on the curve. */
export function arcPointAt(fraction: number, geometry: ArcGeometry): ArcPoint {
  const t = clampFraction(fraction);
  const { x0, x1, base, amplitude } = controls(geometry);
  return { x: lerp(x0, x1, t), y: base - 4 * amplitude * t * (1 - t) };
}

/** The whole day, as one SVG path command. */
export function arcPath(geometry: ArcGeometry): string {
  const { x0, x1, base, cx, cy } = controls(geometry);
  return `M ${r(x0)} ${r(base)} Q ${r(cx)} ${r(cy)} ${r(x1)} ${r(base)}`;
}

/**
 * The day up to `fraction`, as its own path, so it can take the accent stroke.
 *
 * Split with de Casteljau rather than by sampling the curve into a polyline: a
 * sub-curve of a quadratic is exactly another quadratic, so the elapsed stroke
 * lies precisely on top of the track it covers. A sampled approximation drifts
 * off the track by a fraction of a pixel, and two nearly-coincident strokes is
 * the one artefact that reads as a blur rather than as a line.
 */
export function arcPathTo(fraction: number, geometry: ArcGeometry): string {
  const t = clampFraction(fraction);
  const { x0, base, cx, cy } = controls(geometry);
  const end = arcPointAt(t, geometry);
  return (
    `M ${r(x0)} ${r(base)} ` +
    `Q ${r(lerp(x0, cx, t))} ${r(lerp(base, cy, t))} ${r(end.x)} ${r(end.y)}`
  );
}

/** Three decimals: SVG parses shorter strings faster and no display resolves more. */
function r(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '0';
}
