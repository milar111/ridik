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
  /**
   * The ember as *ink*, which is not the ember as *light*.
   *
   * `accent` used to be the ramp's own `hot`, and a ramp's top is chosen to
   * glow rather than to be read: two of the three failed 4.5:1 against a chip
   * of their own colour, and the default failed against the sunken ground as
   * well. They are the same hue and chroma, moved only in lightness until they
   * clear as text. `heat.core` stays exempt and stays vivid — it is a gradient
   * stop, and nothing is ever written on it.
   */
  accent: { light: string; dark: string };
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
    accent: { light: '#B4320E', dark: '#FF8253' },
    light: { cold: '#F2CBBD', low: '#E59E89', mid: '#D86F52', hot: '#C7360F', onHeat: '#FFF7F1' },
    dark: { cold: '#4F2216', low: '#82321F', mid: '#B84329', hot: '#FF5A36', onHeat: '#17100C' },
    platePeak: 'mid',
  },
  // #A82318 at 24 / 48 / 72; #F04B3C at 26 / 50 / 74.
  kiln: {
    name: 'kiln',
    label: 'Kiln',
    note: 'Further from orange. A firing chamber, not a coil.',
    accent: { light: '#A82318', dark: '#F36F62' },
    light: { cold: '#EAC4BD', low: '#D6928A', mid: '#C15F56', hot: '#A82318', onHeat: '#FFF7F1' },
    dark: { cold: '#4F1F18', low: '#822D24', mid: '#B83C30', hot: '#F04B3C', onHeat: '#17100C' },
    platePeak: 'low',
  },
  // #96341A at 26 / 50 / 75; #DE6038 at 25 / 49 / 74.
  rust: {
    name: 'rust',
    label: 'Rust',
    note: 'Browner and quieter. Oxidised steel.',
    accent: { light: '#96341A', dark: '#E57C5D' },
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
  accent: '#B4320E',
  accentMuted: 'rgba(180, 50, 14, 0.12)',
  /**
   * Two temperatures, and that is the whole semantic palette.
   *
   * It used to be four hues — green, yellow, red, blue — sitting on a warm
   * ground beside the ember, and the arithmetic is what condemned them. Their
   * hues were 8°, 34°, 150° and 193°: three of the five crowded into the warm
   * quadrant while two shouted from across the wheel. `danger` landed **5° from
   * `accent`**, so the one colour that has to be seen was the one that looked
   * exactly like the brand, and `warning` at 34° read as a dirty orange rather
   * than as a warning. Meaning cannot live in hue when the hues are that close,
   * and a reader should not have to learn a five-colour legend to use an
   * organiser.
   *
   * So there are two, and they are a temperature pair, which is the one thing
   * this product's vernacular already knew how to say:
   *
   *   **warm** — live, yours, now, going out, needs you. The ember.
   *   **cool** — settled, kept, done, coming in. Metal that has cooled.
   *
   * `success` and `info` are the same slate, because they were never doing
   * different jobs here: a finished task and a rest interval are both "nothing
   * to do". `warning` *is* the accent, because "at risk" is an attention state
   * and attention is what the accent means — it is told apart from a plain
   * accent chip by its word, not by a second hue.
   *
   * Severity is carried by **weight, not by hue**. A tint with coloured text is
   * a state worth noticing; a solid fill with ground-coloured ink is a state
   * that needs acting on. That is why `danger` can stay inside the warm family —
   * it is the far end of it, and it almost always arrives as a fill or beside a
   * word that says "Overdue". A red that has to out-shout an orange on an orange
   * product is a fight it loses; this one does not pick it.
   *
   * Which *direction* that weight goes is not the same in the two schemes, and
   * pretending it was is what made the dark palette mesh. Light has room below
   * the ember, so danger is the burnt end: darker, deeper, redder. Dark has no
   * room below — a colour readable on `surface` bottoms out at L* 62.6 and the
   * accent is already 67.9, so every "deeper" red down there is a red nobody can
   * read. Weight in a dark room is emitted light, so danger climbs instead, to a
   * pale ash-rose that is the brightest thing on the screen and unmistakably red
   * rather than orange. Same rule, opposite direction, because the ground is.
   *
   * Every value below clears 4.5:1 as text on `surface`, on `bg`, and on its
   * own muted tint — that last one is new, and is what fixed chips whose label
   * sat on a plate of its own colour.
   */
  success: '#2E5061',
  successMuted: 'rgba(46, 80, 97, 0.12)',
  warning: '#B4320E',
  warningMuted: 'rgba(180, 50, 14, 0.12)',
  danger: '#7F1D1A',
  dangerMuted: 'rgba(127, 29, 26, 0.12)',
  info: '#2E5061',
  infoMuted: 'rgba(46, 80, 97, 0.12)',
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
  success: '#86AFC1',
  successMuted: 'rgba(134, 175, 193, 0.16)',
  warning: '#FF8253',
  warningMuted: 'rgba(255, 130, 83, 0.16)',
  danger: '#F2B5B0',
  dangerMuted: 'rgba(242, 181, 176, 0.16)',
  info: '#86AFC1',
  infoMuted: 'rgba(134, 175, 193, 0.16)',
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
 * `accent` is the *text-safe* ember, and it is a field on the option rather than
 * a stop on its ramp. It was `hot` for as long as the two happened to agree, and
 * they stopped agreeing the moment the chips were measured on the ground they
 * are actually drawn on: kiln's dark `hot` (#F04B3C) and rust's (#DE6038) are
 * *emitting* colours, correct for a heat cell and 3.85:1 against their own muted
 * tint, which is a label nobody can read. A ramp and an ink are two jobs.
 *
 * Every ember's accent clears 4.5:1 on `bg`, `surface`, `surfaceSunken` and on
 * its own tint, in both schemes; `surfaceRaised` is deliberately outside that —
 * it is a raised card that almost never carries accent text, and the two darker
 * embers land at about 4.2 on it.
 *
 * `ember` itself resolves to the hand-drawn `Colors` unchanged, so the default
 * look cannot move; its `accent` field carries the same hex those tokens do,
 * which is what `theme.test.ts` holds it to.
 */
function emberColors(scheme: ColorScheme, option: EmberOption): Colors {
  const base = scheme === 'dark' ? darkColors : lightColors;
  if (option.name === DEFAULT_EMBER) return base;
  const accent = option.accent[scheme];
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
 * The tint a **subject, event kind or person** is drawn in.
 *
 * Read the list again: it is short, and it used to be everything. Tags,
 * spending categories, project kinds, habit and project chips on Activity, note
 * rows — all of them took a colour from this ramp, hashed from a word, and none
 * of them needed one. The row said "Hardware" and drew a bar beside it in a
 * colour that meant nothing; two rows regularly came out identical anyway,
 * because five tints and a hash collide constantly. A hue that is wrong half
 * the time and meaningless the other half is not a weak signal, it is noise.
 *
 * What is left is the one use colour is actually for here: a **categorical
 * channel** — many peers on one screen, each needing to be told from the next at
 * a glance, with no other mark doing the job. A timetable grid, a month of event
 * dots, a column of avatars. Everywhere else the word is the identity and the
 * chip is quiet until it is the one that is chosen.
 *
 * Two things were wrong with the eight-hue set this ramp replaced, and the
 * second one is a bug rather than a taste.
 *
 * It was eight unrelated hues — a green, a teal, a magenta, an olive, a forest
 * — picked by hashing the word. A hash carries no information, so the colour
 * was decoration that *looked* like meaning: nothing about "School" is blue.
 * On a ground whose whole rule is one temperature, eight of them read as
 * confetti dropped on a photograph. These are five, and they are the ember
 * family plus the one cool counterweight the semantics already use, so a strip
 * of chips reads as a set rather than as a spill. The word still carries the
 * identity; the colour only helps you find the same thing twice.
 *
 * And **it has to know the scheme**. The old values were fixed dark hues used
 * as *text*, which is fine on linen and unreadable on a near-black ground:
 * every one of the eight measured between 2.45:1 and 3.55:1 in dark mode, in
 * Notes, Money, People, Projects, the timetable and Activity. There is no
 * single mid-tone that clears 4.5:1 against both grounds at any useful chroma —
 * the best available is 3.80 — so one constant cannot serve both, and the
 * function takes the scheme rather than pretending otherwise. Both ramps are
 * solved to clear 4.6:1 as text on every ground of their scheme.
 */
/* Warm to cool in five steps, at one lightness so no member of the set shouts
   over the others — the second slot used to sit at hue 32°, which on a warm
   ground reads as a gold that belongs to no other part of this app. It is a
   terracotta now, at 24°, which keeps the step between the ember and the taupe
   while staying inside the family.

   Every value clears 4.6:1 as text on all three grounds of its scheme **and on
   its own muted tint**, which is the check that was missing: the dark ember and
   the dark taupe measured 4.16 and 4.39 against a plate of themselves, so a
   chip drawn in either was a label a reader had to work at. Both were lifted
   about four L* with their hue and chroma held, which also closed the ramp's
   own spread from six L* to two — members of a categorical set have to be
   equally loud, or the lightest one reads as the selected one. */
const TAG_TINTS: Record<ColorScheme, readonly string[]> = {
  light: ['#AC3915', '#8A4F2C', '#7A5A48', '#3B677D', '#46686D'],
  dark: ['#EA7957', '#C98A63', '#B59482', '#6DA1BA', '#7CA5AB'],
};

export function colorForTag(tag: string, scheme: ColorScheme): string {
  const ramp = TAG_TINTS[scheme];
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
  return ramp[hash % ramp.length]!;
}
