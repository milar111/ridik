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

/**
 * The cell ramp — one ember at four opacities, resolved.
 *
 * Every graphic in the widget family and in the habit grid is built from a cell
 * filled with one of these. Resolved rather than composited at draw time because
 * the same four values have to exist identically in Swift and in Android XML,
 * and "the same alpha over the same ground" is a promise three languages would
 * each have to keep. These are the arithmetic done once.
 *
 * `hot` is spent sparingly on purpose: exactly one cell per drawing, always the
 * single most urgent thing. That cap is what keeps saturated orange to a percent
 * or two of any surface — the structural answer to a hue somebody dislikes, and
 * a better one than picking a duller colour.
 *
 * Ink sits on `cold`, `low` and `mid`; on `hot` it inverts to `onHeat`. Both
 * sides clear 4.5:1 in both schemes. Ink on `hot` measures 3.2:1 and must never
 * be used.
 */
export type CellRamp = { cold: string; low: string; mid: string; hot: string; onHeat: string };

/**
 * The embers the user can choose between.
 *
 * One colour at four opacities is the whole visual system, so this is the only
 * thing a colour setting has to change — and changing it is genuinely one entry
 * here rather than a sweep through every face.
 *
 * `platePeak` is not decoration. The month plate is the one place in the family
 * where text sits *on* a filled cell, and a darker ember's mid cell cannot stay
 * light enough for near-black numerals while its hot cell stays dark enough for
 * linen. That is not a tuning problem: no ramp satisfies both on the sand
 * ground, at any alphas, and a paler ground does not rescue it. So a darker
 * ember caps the plate's load at `low` in light mode — busy and very busy read
 * alike there — and keeps all four levels in dark, where the constraint does
 * not exist. `ember` is the only one that keeps `mid`, which is why it is the
 * default rather than merely the first.
 */
export type EmberName = 'ember' | 'kiln' | 'rust';

export type EmberOption = {
  name: EmberName;
  /** What the Settings row calls it. */
  label: string;
  /** One line, in the user's terms, not the palette's. */
  note: string;
  light: CellRamp;
  dark: CellRamp;
  /** The hottest level the month plate may use in light mode. */
  platePeak: 'mid' | 'low';
};

/**
 * Every level below `hot` is its ember composited over `tile` at the alpha in
 * the comment, and `onHeat` *is* `tile`. Both facts are load-bearing.
 *
 * Compositing over the tile rather than picking six colours by eye is what lets
 * the ramp be re-solved when the ground moves — which it did, once, and the
 * hand-picked values it replaced were the reason empty widgets looked washed
 * out. The alphas differ per ember and per scheme because the constraints bind
 * differently: a darker ember needs more of itself to clear the resting floor,
 * and dark mode needs less to clear the step between levels.
 *
 * `onHeat` being the tile is what makes an inverted numeral read as the ground
 * showing *through* a lit cell rather than as white paint on top of it.
 */
export const embers: Record<EmberName, EmberOption> = {
  // #C7360F over linen at 23 / 46 / 71; #FF5A36 over near-black at 24 / 46 / 70.
  ember: {
    name: 'ember',
    label: 'Ember',
    note: 'The original. A coil at temperature.',
    light: { cold: '#F2CBBD', low: '#E59E89', mid: '#D86F52', hot: '#C7360F', onHeat: '#FFF7F1' },
    dark: { cold: '#4F2216', low: '#82321F', mid: '#B84329', hot: '#FF5A36', onHeat: '#17100C' },
    platePeak: 'mid',
  },
  // #A82318 at 24 / 48 / 72; #F04B3C at 26 / 50 / 74.
  kiln: {
    name: 'kiln',
    label: 'Kiln',
    note: 'Further from orange. A firing chamber, not a coil.',
    light: { cold: '#EAC4BD', low: '#D6928A', mid: '#C15F56', hot: '#A82318', onHeat: '#FFF7F1' },
    dark: { cold: '#4F1F18', low: '#822D24', mid: '#B83C30', hot: '#F04B3C', onHeat: '#17100C' },
    platePeak: 'low',
  },
  // #96341A at 26 / 50 / 75; #DE6038 at 25 / 49 / 74.
  rust: {
    name: 'rust',
    label: 'Rust',
    note: 'Browner and quieter. Oxidised steel.',
    light: { cold: '#E4C5BA', low: '#CA9585', mid: '#B16651', hot: '#96341A', onHeat: '#FFF7F1' },
    dark: { cold: '#492417', low: '#783721', mid: '#AA4B2D', hot: '#DE6038', onHeat: '#17100C' },
    platePeak: 'low',
  },
};

/**
 * The widget's own ground, and why it is not the app's.
 *
 * The app is a saturated warm field because it is a hero screen — one surface,
 * filling the phone, lit as though the microphone were the heat source. A
 * widget is a guest on somebody else's home screen, sitting between other
 * apps' tiles, and the same saturation there reads as shouting. Every
 * well-made widget in the wild is pale for this reason.
 *
 * It also measures better. The ramp resolved against this tile separates *more*
 * from its own ground than the one resolved against the app's `bg` did — 1.56:1
 * against 1.39:1 for a resting cell. The tile being too saturated is what made
 * empty widgets look washed out, and raising the ember was treating the
 * symptom.
 *
 * One ramp still serves both surfaces: solved against this, the harder ground,
 * it clears the floor on the app's card too (1.53:1 and 1.39:1 in dark).
 */
export const tile: Record<ColorScheme, string> = {
  light: '#FFF7F1',
  dark: '#17100C',
};

/**
 * Depth, as four values.
 *
 * Not shadows — a widget cannot cast one, and on Android it cannot even ask.
 * These are the edges that make a cell read as sitting *in* a surface rather
 * than *on* it: a dark lip at the top of a track, a light one at its bottom, a
 * highlight along the top of a lit segment, and a single soft bloom in one
 * corner of the tile.
 *
 * The bloom is the only gradient anywhere in the family and it is deliberately
 * local. A gradient across a whole tile is a wash, and a wash is what makes a
 * surface look printed rather than lit; a gradient across one corner reads as a
 * light source, which is the entire idea the palette is named after.
 */
export type DepthRamp = {
  /** The recessed lip at the top of a track. */
  well: string;
  /** The light edge at the bottom of one, catching the same light. */
  wellFloor: string;
  /** Along the top of a lit segment, so it sits proud of its slot. */
  bevel: string;
  /** The corner bloom's centre. It fades to fully transparent. */
  bloom: string;
};

export const depth: Record<ColorScheme, DepthRamp> = {
  light: {
    well: '#14000000',
    wellFloor: '#B3FFFFFF',
    bevel: '#66FFFFFF',
    bloom: '#1FC7360F',
  },
  // Dark needs roughly double: the same alpha over a near-black ground moves a
  // fraction as far in perceived lightness as it does over linen.
  dark: {
    well: '#38000000',
    wellFloor: '#14FFFFFF',
    bevel: '#26FFFFFF',
    bloom: '#3DFF5A36',
  },
};

/** What a fresh install draws, and what every screenshot in the store shows. */
export const DEFAULT_EMBER: EmberName = 'ember';

/** Every ember, in the order Settings offers them. The default is first. */
export const EMBER_NAMES = Object.keys(embers) as EmberName[];

/** Total, because the stored value is decoded from JSON a build may not know. */
export function isEmberName(value: unknown): value is EmberName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(embers, value);
}

/**
 * The default ember's ramp — what everything that has not been told otherwise
 * draws.
 *
 * Light is #C7360F over the tile at 23% / 46% / 71% / 100%; dark is #FF5A36 at
 * 24% / 46% / 70% / 100%, and the direction of travel inverts — heat brightens
 * away from the ground instead of darkening toward it, which is why dark reads
 * as an emitting instrument rather than a printed one.
 *
 * The resting cell used to sit at 14%, which is 1.22:1 against its own tile —
 * technically present and, on a widget with nothing in it, indistinguishable
 * from a plain card. It now reads 1.41:1 against the pale tile: still
 * unmistakably *off*, but the grid reads as an instrument at rest instead of a
 * wash. Note which lever bought that. Raising the *ember* was tried first and
 * made the tile shout without making the resting cell any clearer; lowering the
 * *ground* moved the whole ramp at once. See `widget-tokens.test.ts` for the
 * arithmetic that is still enforced.
 *
 * Read off `embers` rather than written out again: these were two copies of the
 * same eight values, which is the drift this file spends its comments warning
 * about. It is also the thing that keeps "the default is the current look" true
 * by construction rather than by inspection.
 */
export const cells: Record<ColorScheme, CellRamp> = {
  light: embers[DEFAULT_EMBER].light,
  dark: embers[DEFAULT_EMBER].dark,
};

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
  /** Which ember this theme was resolved from. */
  ember: EmberName;
  colors: Colors;
  heat: HeatRamp;
  /** The four-step cell ramp every grid and widget is built from. */
  cells: CellRamp;
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
};

/** The alpha `accentMuted` has always been, per scheme. */
const MUTED_ALPHA: Record<ColorScheme, number> = { light: 0.12, dark: 0.16 };

/** One of the palette's own hexes at an opacity, never a new hue. */
function withAlpha(hex: string, alpha: number): string {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/**
 * The two accent tokens, for an ember that has no hand-drawn set.
 *
 * `accent` is the *text-safe* ember — the one that clears 4.5:1 on the ground it
 * sits on — and in every ramp that is `hot`: in light because the light ramp
 * descends into ink, and in dark because it climbs into emission. Both clear
 * 4.5:1 on `bg` and on `surface` for all three embers; on `surfaceRaised`, which
 * almost never carries accent text, the darker two land at about 4.2.
 *
 * `ember` itself is deliberately exempt. `darkColors.accent` is a lightened
 * #FF8253 that exists in no `CellRamp`, and re-deriving it from `dark.hot` would
 * move the default look — which is the one thing this feature must not do.
 */
function emberColors(scheme: ColorScheme, option: EmberOption): Colors {
  const base = scheme === 'dark' ? darkColors : lightColors;
  if (option.name === DEFAULT_EMBER) return base;
  const accent = option[scheme].hot;
  return { ...base, accent, accentMuted: withAlpha(accent, MUTED_ALPHA[scheme]) };
}

/**
 * The home screen's field, for an ember that has no hand-drawn set.
 *
 * The core is always the *emitting* ember — the dark ramp's `hot`, which is
 * exactly what `heat.core` already is in both schemes — and the falloff then
 * walks that scheme's own ramp back toward its ground: down through `mid` and
 * `low` in dark, up through `low` and `cold` in light. `hot` and `mid` are
 * skipped in light because there the ramp travels *away* from the ground into
 * ink, and a stop darker than the one outside it draws a muddy ring rather than
 * a falloff.
 *
 * `ember` keeps its hand-drawn field for the same reason it keeps its accent.
 */
function emberHeat(scheme: ColorScheme, option: EmberOption): HeatRamp {
  if (option.name === DEFAULT_EMBER) return heat[scheme];
  const core = option.dark.hot;
  return scheme === 'dark'
    ? { core, mid: option.dark.mid, edge: option.dark.low, rim: option.dark.onHeat }
    : { core, mid: option.light.low, edge: option.light.cold, rim: option.light.onHeat };
}

/**
 * The whole palette, from a scheme and a chosen ember.
 *
 * The ember defaults, so every caller that only knows about light and dark —
 * the root layout painting the system background, the error boundary that has
 * no provider above it — keeps working and keeps drawing the default.
 */
export function makeTheme(scheme: ColorScheme, ember: EmberName = DEFAULT_EMBER): Theme {
  const option = embers[ember] ?? embers[DEFAULT_EMBER];
  return {
    scheme,
    ember: option.name,
    colors: emberColors(scheme, option),
    cells: option[scheme],
    heat: emberHeat(scheme, option),
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
