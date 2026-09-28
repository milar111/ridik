/**
 * The ink a filled surface asks for.
 *
 * `theme.ts` opens with the rule: every "white" here is linen and every "black"
 * is a warm brown, because a true white next to this palette reads as a bug.
 * Seven glyphs and labels drawn *on* a fill were breaking it with `#FFFFFF` —
 * and one hardcoded white is worse than a cosmetic slip, because a fill is not
 * always dark. `colors.accent` is a deep rust in light and #FF8253 in dark;
 * white on the second measures 2.45:1, and the cool token in dark is worse.
 * Both were shipping.
 *
 * So the ink is not a constant, it is a *function of the fill*. The two values
 * it chooses between are the palette's own: `CellRamp.onHeat`, which is exactly
 * this idea already solved for the widget cells — linen in light, near-black in
 * dark, identical across all three embers. Nothing new is introduced here; this
 * only asks which of the pair a given fill needs, which is the question a chip
 * tinted by `colorForTag()` has to answer at runtime because its fill does not
 * follow the scheme.
 *
 * `src/ui/__tests__/warm-ink.test.ts` measures every fill this app actually
 * puts ink on, in both schemes and all three embers, and fails below 4.5:1.
 */
import { cells } from './theme';

/** The palette's "white" — linen, for ink on a dark fill. */
export const LINEN = cells.light.onHeat;

/** The palette's "black" — a warm near-black, for ink on a light fill. */
export const SOOT = cells.dark.onHeat;

/** `#rgb`, `#rrggbb` or `rgb()`/`rgba()`. Anything else has no channels to read. */
function channels(color: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const digits = hex[1]!;
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((d) => d + d)
            .join('')
        : digits;
    return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as [number, number, number];
  }

  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb) {
    const parts = rgb[1]!.split(',').map((part) => Number(part.trim()));
    const [r, g, b] = parts;
    if (parts.length >= 3 && [r, g, b].every((v) => Number.isFinite(v))) {
      return [r!, g!, b!];
    }
  }

  return null;
}

const toLinear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

/**
 * WCAG relative luminance, or `null` for a colour with no channels to read.
 *
 * Alpha is deliberately ignored: every fill this is asked about is opaque, and
 * a translucent one would need the ground beneath it to answer honestly rather
 * than a guess that looks like an answer.
 */
export function luminance(color: string): number | null {
  const rgb = channels(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((value) => toLinear(value / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const LINEN_LUMINANCE = luminance(LINEN)!;
const SOOT_LUMINANCE = luminance(SOOT)!;

function ratio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Linen or soot, whichever reads better on `fill`.
 *
 * Ties and unreadable colours go to linen, which is what every one of these
 * call sites used to be — an unparseable fill is a caller bug, and changing the
 * look of one is a worse way to report it than leaving it as it was.
 */
export function inkOn(fill: string): string {
  const own = luminance(fill);
  if (own == null) return LINEN;
  return ratio(LINEN_LUMINANCE, own) >= ratio(SOOT_LUMINANCE, own) ? LINEN : SOOT;
}

/**
 * A colour at an opacity — a *plate* of it, rather than the colour itself.
 *
 * The palette hands out `accentMuted`, `successMuted` and the rest for exactly
 * this, and they are enough right up to the point where the tint is not a
 * palette token: a tag colour, or an ember chosen in Settings. This is the same
 * arithmetic for a fill that arrives at runtime.
 *
 * The alphas are the palette's own, and they differ by scheme because the two
 * grounds do: 12% of a dark ink over linen is the same *presence* as 16% of a
 * pale one over soot.
 */
export function plateOf(color: string, scheme: 'light' | 'dark'): string {
  const rgb = channels(color);
  if (!rgb) return 'transparent';
  const [r, g, b] = rgb;
  return `rgba(${r}, ${g}, ${b}, ${scheme === 'dark' ? 0.16 : 0.12})`;
}
