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

  /* `accent` is a field on the ember, not a stop on its ramp. It was `hot` for
     as long as the two happened to agree, and they stopped agreeing the moment
     the ramps were held to their own contrast: kiln's dark `hot` (#F04B3C) and
     rust's (#DE6038) are *emitting* colours, right for a cell and 3.85:1 on
     their own muted tint, which is a chip nobody can read. The heat ramp and
     the text-safe ink are two different jobs and now have two different
     fields. */
  it.each(SCHEMES)('%s: takes the accent from its own set', (scheme) => {
    for (const name of EMBER_NAMES) {
      expect(makeTheme(scheme, name).colors.accent).toBe(embers[name].accent[scheme]);
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
     every ember — the default included — clears the bar outright on all three
     grounds a label sits on. `surfaceRaised` is deliberately not in the list: it
     is a raised card that almost never carries accent text, and the two darker
     embers land at about 4.2 on it.

     There is no exemption for the default any more. It carried one — a floor of
     4.4, because #C7360F measured 4.48 on the sand ground and rounding it up
     would have asserted something untrue about the app — and the honest way to
     retire a rule that reads "this is nearly good enough" is to fix the colour
     rather than to keep restating the shortfall. #B4320E measures 5.21. */
  it.each(SCHEMES)('%s: leaves the accent legible on the grounds it sits on', (scheme) => {
    for (const name of EMBER_NAMES) {
      const { colors } = makeTheme(scheme, name);
      for (const ground of [colors.bg, colors.surface, colors.surfaceSunken]) {
        expect(contrast(colors.accent, ground)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  /* The ground a tinted chip actually has is not `surface` — it is `surface`
     with the accent's own muted tint composited over it, and that tint is built
     from the accent, so a colour too light to read is *doubly* too light there.
     Nothing measured it, and that is exactly how kiln and rust shipped chips at
     3.85:1: every check in this file was passing, on a ground the chip was not
     drawn on. */
  it.each(SCHEMES)('%s: leaves the accent legible on its own tint', (scheme) => {
    for (const name of EMBER_NAMES) {
      const { colors } = makeTheme(scheme, name);
      const chip = over(colors.accentMuted, colors.surface);
      expect(contrast(colors.accent, chip)).toBeGreaterThanOrEqual(4.5);
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

/**
 * An `rgba()` tint composited over an opaque hex, as a hex.
 *
 * A muted token is never seen on its own — it is paint laid over a card, and
 * what a chip's label is actually read against is the result. Source-over on
 * straight 8-bit channels, which is what both platforms do.
 */
function over(tint: string, ground: string): string {
  const [r, g, b, a] = tint
    .slice(tint.indexOf('(') + 1, -1)
    .split(',')
    .map((part) => Number(part.trim())) as [number, number, number, number];
  const mix = [r, g, b].map((c, i) =>
    Math.round(c * a + parseInt(ground.slice(1 + i * 2, 3 + i * 2), 16) * (1 - a)),
  );
  return `#${mix.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}
