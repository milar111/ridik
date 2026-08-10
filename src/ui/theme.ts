/**
 * Design tokens — "element".
 *
 * Ridik is one button you talk to on a screen that is otherwise empty. That
 * emptiness is the design, so the ground has to carry the product rather than
 * get out of its way: a saturated warm field, lit as though the microphone were
 * the heat source. The vernacular comes from where this app is actually used —
 * a maker lab, where warmth means a soldering iron coming up to temperature and
 * filament going soft, not a sunset.
 *
 * Two rules keep it from drifting:
 *
 * - **Nothing here is neutral grey.** Every "black" is a warm brown and every
 *   "white" is linen. A true grey next to this palette reads as a bug.
 * - **`accent` is the text-safe ember, not the hot one.** The vivid core lives
 *   in `heat` below and is only ever a large fill behind a white glyph. Using
 *   it for a 13pt label would put orange on peach at about 3:1.
 */

export type ColorScheme = 'light' | 'dark';

/**
 * The field's ramp, hottest first. Not part of `Colors`: these are the stops of
 * a gradient and a glow, never a text or border colour.
 */
export type HeatRamp = { core: string; mid: string; edge: string; rim: string };

export const heat: Record<ColorScheme, HeatRamp> = {
  light: { core: '#FF5A36', mid: '#FF8A52', edge: '#FFB57E', rim: '#FFE3CB' },
  // The same fire seen in a dark room: the core holds, everything behind it
  // falls away to the ground colour instead of rising to peach.
  dark: { core: '#FF5A36', mid: '#C43C18', edge: '#6E2810', rim: '#1C0E06' },
};

export type Colors = {
  bg: string;
  surface: string;
  surfaceRaised: string;
  surfaceSunken: string;
  border: string;
  borderStrong: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  accentMuted: string;
  success: string;
  successMuted: string;
  warning: string;
  warningMuted: string;
  danger: string;
  dangerMuted: string;
  info: string;
  infoMuted: string;
  overlay: string;
};

export const lightColors: Colors = {
  // Warm sand, not white. Every screen that is not home sits on the cooled
  // edge of the same field the home screen is lit by.
  bg: '#FFE8D4',
  surface: '#FFF7F0',
  surfaceRaised: '#FFFCF8',
  surfaceSunken: '#FFDCC0',
  border: 'rgba(46, 21, 8, 0.12)',
  borderStrong: 'rgba(46, 21, 8, 0.24)',
  text: '#2E1508',
  // Heavier than they would be on white. This ground is a mid-tone and it
  // moves — the field brightens under the text while the mic is listening —
  // so a secondary that only just held on peach would drop out on ember.
  textSecondary: 'rgba(46, 21, 8, 0.74)',
  textTertiary: 'rgba(46, 21, 8, 0.56)',
  // Deep enough to clear 4.5:1 on the sand ground; `heat.core` is the vivid one.
  accent: '#C7360F',
  accentMuted: 'rgba(199, 54, 15, 0.12)',
  success: '#0F7A55',
  successMuted: 'rgba(15, 122, 85, 0.12)',
  warning: '#9C5300',
  warningMuted: 'rgba(156, 83, 0, 0.14)',
  danger: '#BE2A18',
  dangerMuted: 'rgba(190, 42, 24, 0.12)',
  info: '#0B6A8F',
  infoMuted: 'rgba(11, 106, 143, 0.12)',
  overlay: 'rgba(46, 21, 8, 0.40)',
};

export const darkColors: Colors = {
  bg: '#1C0E06',
  surface: '#2A1710',
  surfaceRaised: '#361F15',
  surfaceSunken: '#140904',
  border: 'rgba(255, 214, 184, 0.12)',
  borderStrong: 'rgba(255, 214, 184, 0.26)',
  text: '#FFEEDF',
  textSecondary: 'rgba(255, 238, 223, 0.66)',
  textTertiary: 'rgba(255, 238, 223, 0.44)',
  accent: '#FF8253',
  accentMuted: 'rgba(255, 130, 83, 0.16)',
  success: '#3FD8A0',
  successMuted: 'rgba(63, 216, 160, 0.16)',
  warning: '#FFB74D',
  warningMuted: 'rgba(255, 183, 77, 0.16)',
  danger: '#FF6F5C',
  dangerMuted: 'rgba(255, 111, 92, 0.16)',
  info: '#5CC8F5',
  infoMuted: 'rgba(92, 200, 245, 0.16)',
  overlay: 'rgba(10, 4, 1, 0.68)',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 10,
  md: 16,
  lg: 22,
  xl: 30,
  pill: 999,
} as const;

/**
 * Font families, by the keys `loadAppFonts` registers them under.
 *
 * Two faces with one job each. Bricolage Grotesque is the human half — it has
 * enough character at display sizes to carry a screen with nothing else on it.
 * Martian Mono is the instrument half, and is reserved for the two things the
 * machine reports rather than says: times, and the small tracked eyebrows that
 * label a region. Mixing them anywhere else blurs the distinction and the
 * pairing stops meaning anything.
 */
export const fonts = {
  display: 'Bricolage_800ExtraBold',
  bold: 'Bricolage_700Bold',
  semibold: 'Bricolage_600SemiBold',
  medium: 'Bricolage_500Medium',
  regular: 'Bricolage_400Regular',
  mono: 'Martian_500Medium',
  monoLight: 'Martian_300Light',
} as const;

export const typography = {
  display: { fontSize: 34, lineHeight: 38, fontFamily: fonts.display, letterSpacing: -0.8 },
  title: { fontSize: 24, lineHeight: 29, fontFamily: fonts.bold, letterSpacing: -0.4 },
  heading: { fontSize: 17, lineHeight: 22, fontFamily: fonts.semibold, letterSpacing: -0.2 },
  body: { fontSize: 15, lineHeight: 21, fontFamily: fonts.regular },
  bodyStrong: { fontSize: 15, lineHeight: 21, fontFamily: fonts.semibold, letterSpacing: -0.1 },
  caption: { fontSize: 13, lineHeight: 18, fontFamily: fonts.regular },
  /**
   * Region labels — "AGENDA", "DUE TODAY". Tracked wide and small, an
   * instrument's engraving.
   *
   * Separate from `micro` on purpose. `micro` is used a hundred-odd times for
   * small secondary text, and setting *that* in the mono put a wide monospace
   * under every agenda row and count in the app. The mono earns its meaning by
   * being rare: times, and the labels that name a region.
   */
  eyebrow: { fontSize: 10, lineHeight: 14, fontFamily: fonts.mono, letterSpacing: 1.4 },
  micro: { fontSize: 11, lineHeight: 15, fontFamily: fonts.medium, letterSpacing: 0.1 },
  mono: { fontSize: 13, lineHeight: 18, fontFamily: fonts.mono, letterSpacing: -0.2 },
  /** The one number worth reading across the room: the next thing's time. */
  readout: { fontSize: 40, lineHeight: 44, fontFamily: fonts.mono, letterSpacing: -1.8 },
  timer: { fontSize: 54, lineHeight: 60, fontFamily: fonts.monoLight, letterSpacing: -2 },
} as const;

export type Theme = {
  scheme: ColorScheme;
  colors: Colors;
  heat: HeatRamp;
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
};

export function makeTheme(scheme: ColorScheme): Theme {
  return {
    scheme,
    colors: scheme === 'dark' ? darkColors : lightColors,
    heat: scheme === 'dark' ? heat.dark : heat.light,
    spacing,
    radius,
    typography,
  };
}

/**
 * Deterministic accent for a tag, kept inside the palette's temperature.
 *
 * The old set was a rainbow, which on this ground would look like confetti
 * dropped on a photograph. These are all things that are warm or adjacent to
 * it, so a tag reads as a tag rather than as an alarm.
 */
const TAG_COLORS = [
  '#C7360F',
  '#9C5300',
  '#0F7A55',
  '#0B6A8F',
  '#A63668',
  '#6B4E16',
  '#B4471F',
  '#3F5C2A',
];

export function colorForTag(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
  return TAG_COLORS[hash % TAG_COLORS.length]!;
}
