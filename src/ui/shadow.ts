/**
 * One shadow, drawn the same way on both platforms.
 *
 * The two APIs React Native inherited cannot agree. `shadowColor`,
 * `shadowOpacity`, `shadowRadius` and `shadowOffset` are read only by iOS;
 * `elevation` is read only by Android, where it is a single number meaning
 * "height" from which the platform derives its own blur, its own offset (always
 * straight down) and its own colour (always black). Setting both is two
 * unrelated shadows that agree only by accident — and here they did not: the
 * home mic was a 28pt warm-brown bloom on iOS and a hard grey Material drop on
 * Android, under a palette whose whole rule is that nothing is neutral grey.
 *
 * `boxShadow` is honoured by both renderers, so one declaration paints one
 * shadow. It needs the New Architecture, which is the only architecture left in
 * React Native 0.86.
 *
 * The numbers below are the iOS ones that were already there. iOS was drawing
 * what the design asked for; this brings Android to it rather than meeting in
 * the middle.
 */
import type { ViewStyle } from 'react-native';

/**
 * The default shadow colour: the ground's own brown burnt a little darker.
 *
 * Android's elevation shadow is pure black and cannot be told otherwise, which
 * is exactly the "true grey next to this palette" the theme warns about.
 */
export const SHADOW_TINT = '#5A1F00';

export type ShadowLevel = 'card' | 'floating' | 'source';

const LEVELS: Record<ShadowLevel, { y: number; blur: number; opacity: number }> = {
  /** A surface lifted just off the ground — the receipt on home. */
  card: { y: 8, blur: 18, opacity: 0.1 },
  /** Chrome hovering over content it must stay legible against — the dock mic. */
  floating: { y: 4, blur: 12, opacity: 0.4 },
  /** The heat source itself: the largest, softest and warmest of the three. */
  source: { y: 14, blur: 28, opacity: 0.28 },
};

/**
 * Re-alphas a colour so a shadow can be tinted by whatever it is cast from.
 *
 * `boxShadow` takes one colour rather than a colour plus an opacity, so the
 * opacity has to be folded in. An existing alpha is multiplied rather than
 * replaced — `colors.border` is already translucent, and a caller asking for
 * "that, at 10%" means 10% of what it can see.
 */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));

  const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim());
  if (hex) {
    const digits = hex[1]!;
    // #RGB and #RGBA are shorthand for a doubled nibble each.
    const full =
      digits.length <= 4
        ? digits
            .split('')
            .map((d) => d + d)
            .join('')
        : digits;
    const channel = (at: number) => parseInt(full.slice(at, at + 2), 16);
    const own = full.length === 8 ? channel(6) / 255 : 1;
    return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${round(own * a)})`;
  }

  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb) {
    const parts = rgb[1]!.split(',').map((part) => part.trim());
    const own = parts.length > 3 ? Number(parts[3]) : 1;
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${round((Number.isFinite(own) ? own : 1) * a)})`;
  }

  // A named colour ("white") has no channels to reach. Nothing in the palette
  // is one, so this is a passthrough rather than a fallback worth designing.
  return color;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * The only way to cast a shadow in this app.
 *
 * @param tint what the shadow is cast *by*, when it should not be the ground's
 *   brown — the dock mic tints its own shadow with its state colour.
 */
export function elevate(level: ShadowLevel, tint: string = SHADOW_TINT): ViewStyle {
  const { y, blur, opacity } = LEVELS[level];
  return {
    boxShadow: [
      { offsetX: 0, offsetY: y, blurRadius: blur, spreadDistance: 0, color: withAlpha(tint, opacity) },
    ],
  };
}
