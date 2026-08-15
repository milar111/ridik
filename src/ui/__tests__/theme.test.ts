/**
 * What a chosen ember is allowed to change, and what it must not.
 *
 * The colour is a setting now, which turns "does this palette work" from a
 * question about one hand-tuned set of hexes into a question about three. The
 * ramps themselves are held to their rules in `widget-tokens.test.ts`; this file
 * holds the *resolution* — that the default still resolves to exactly the app
 * that shipped, and that the two derived tokens (`accent`, `heat`) stay legible
 * and stay inside the palette rather than inventing a hue.
 */
import {
  DEFAULT_EMBER,
  EMBER_NAMES,
  cells,
  darkColors,
  embers,
  heat,
  isEmberName,
  lightColors,
  makeTheme,
  type ColorScheme,
} from '../theme';

const SCHEMES: ColorScheme[] = ['light', 'dark'];

describe('the default ember is the app that shipped', () => {
  it.each(SCHEMES)('%s: resolves to the hand-drawn tokens', (scheme) => {
    const theme = makeTheme(scheme);

    expect(theme.ember).toBe(DEFAULT_EMBER);
    expect(theme.colors).toEqual(scheme === 'dark' ? darkColors : lightColors);
    expect(theme.heat).toEqual(heat[scheme]);
    expect(theme.cells).toEqual(cells[scheme]);
  });

  /* `cells` is read off `embers` rather than written out twice. If that ever
     stops being the same eight values, the widgets and the habit grid are in
     two different palettes with nothing failing anywhere. */
  it('is the ramp `cells` exports', () => {
    expect(cells.light).toBe(embers[DEFAULT_EMBER].light);
    expect(cells.dark).toBe(embers[DEFAULT_EMBER].dark);
  });

  it('is what a caller that has never heard of embers gets', () => {
    expect(makeTheme('dark')).toEqual(makeTheme('dark', DEFAULT_EMBER));
  });
});

describe('a chosen ember', () => {
  it.each(SCHEMES)('%s: repaints the cell ramp', (scheme) => {
    for (const name of EMBER_NAMES) {
      expect(makeTheme(scheme, name).cells).toEqual(embers[name][scheme]);
    }
  });

  it.each(SCHEMES)('%s: takes the accent from its own ramp', (scheme) => {
    for (const name of EMBER_NAMES.filter((n) => n !== DEFAULT_EMBER)) {
      expect(makeTheme(scheme, name).colors.accent).toBe(embers[name][scheme].hot);
    }
  });

  /* The field's core is the *emitting* ember — the dark ramp's `hot` — in both
     schemes, which is what `heat.core` already is for the default. */
  it.each(SCHEMES)('%s: lights the field with its own core', (scheme) => {
    for (const name of EMBER_NAMES.filter((n) => n !== DEFAULT_EMBER)) {
      expect(makeTheme(scheme, name).heat.core).toBe(embers[name].dark.hot);
    }
  });

  /* Every stop has to come out of the ember's own ramps. A gradient stop that
     was invented rather than resolved is a second hue in a palette whose whole
     argument is that it has one. */
  it.each(SCHEMES)('%s: builds the field only out of colours it was given', (scheme) => {
    for (const name of EMBER_NAMES.filter((n) => n !== DEFAULT_EMBER)) {
      const option = embers[name];
      const owned = [...Object.values(option.light), ...Object.values(option.dark)];
      for (const stop of Object.values(makeTheme(scheme, name).heat)) {
        expect(owned).toContain(stop);
      }
    }
  });

  /* The falloff has to travel one way. A stop that is darker than the one
     outside it draws a ring rather than a fade — which is exactly what using
     the light ramp's `mid` would do on the sand ground. */
  it.each(SCHEMES)('%s: fades away from the core without doubling back', (scheme) => {
    for (const name of EMBER_NAMES) {
      const field = makeTheme(scheme, name).heat;
      const steps = [field.core, field.mid, field.edge].map(lightness);
      const rising = scheme === 'light';
      for (let i = 0; i < steps.length - 1; i++) {
        expect(rising ? steps[i + 1]! > steps[i]! : steps[i + 1]! < steps[i]!).toBe(true);
      }
    }
  });

  it('keeps `accentMuted` the accent it belongs to', () => {
    for (const name of EMBER_NAMES) {
      const theme = makeTheme('light', name);
      const [r, g, b] = [1, 3, 5].map((at) => parseInt(theme.colors.accent.slice(at, at + 2), 16));
      expect(theme.colors.accentMuted).toBe(`rgba(${r}, ${g}, ${b}, 0.12)`);
    }
  });

  /* An unreadable label is the one way a colour setting could break the app, so
     an ember that is *chosen* has to clear the bar outright: 4.5:1 on the ground
     it sits on and on the card it sits in. `surfaceRaised` is deliberately not
     in the list — it is a raised card that almost never carries accent text, and
     the two darker embers land at about 4.2 on it.

     The default is held to 4.4 and not 4.5, because that is what it has always
     measured: #C7360F on the sand ground is 4.48. Rounding it up here would be
     asserting something about the app that is not true. */
  it.each(SCHEMES)('%s: leaves the accent legible on the grounds it sits on', (scheme) => {
    for (const name of EMBER_NAMES) {
      const { colors } = makeTheme(scheme, name);
      const floor = name === DEFAULT_EMBER ? 4.4 : 4.5;
      for (const ground of [colors.bg, colors.surface]) {
        expect(contrast(colors.accent, ground)).toBeGreaterThanOrEqual(floor);
      }
    }
  });
});

describe('an ember that is not one', () => {
  it('is not accepted as a stored value', () => {
    expect(isEmberName('kiln')).toBe(true);
    expect(isEmberName('teal')).toBe(false);
    expect(isEmberName(null)).toBe(false);
  });

  /* A row written by a build that shipped a fourth ember must not leave the app
     with no palette at all — every screen renders under this. */
  it('resolves to the default rather than to nothing', () => {
    const theme = makeTheme('dark', 'teal' as never);
    expect(theme).toEqual(makeTheme('dark', DEFAULT_EMBER));
  });
});

/* --------------------------------------------------------------- arithmetic */

function channel(hex: string, at: number): number {
  return parseInt(hex.slice(at, at + 2), 16) / 255;
}

function linear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return (
    0.2126 * linear(channel(hex, 1)) +
    0.7152 * linear(channel(hex, 3)) +
    0.0722 * linear(channel(hex, 5))
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** CIE L*, which is where "a step you can see" is measurable. */
function lightness(hex: string): number {
  const y = luminance(hex);
  return y > 0.008856 ? 116 * y ** (1 / 3) - 16 : 903.3 * y;
}
