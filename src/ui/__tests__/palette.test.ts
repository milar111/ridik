/**
 * The palette's own rules, as arithmetic.
 *
 * `theme.ts` opens with two of them in prose — nothing is neutral grey, and
 * `accent` is the text-safe ember rather than the hot one. Prose is what the
 * file already had when four semantic colours drifted to 78–100% saturation
 * one at a time, each defensible on its own and jarring together, because
 * nothing measures a palette as a set.
 *
 * These do. They are deliberately loose: this is a floor against drift, not a
 * design review, and a rule tight enough to encode taste would be a rule
 * somebody turns off the first time it is inconvenient.
 */
import { colorForTag, darkColors, heat, lightColors } from '../theme';

const SCHEMES = { light: lightColors, dark: darkColors } as const;

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function hsl(hex: string): { hue: number; sat: number; light: number } {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { hue: 0, sat: 0, light: light * 100 };
  const sat = delta / (1 - Math.abs(2 * light - 1));
  const hue =
    max === r
      ? 60 * (((g - b) / delta) % 6)
      : max === g
        ? 60 * ((b - r) / delta + 2)
        : 60 * ((r - g) / delta + 4);
  return { hue: ((hue % 360) + 360) % 360, sat: sat * 100, light: light * 100 };
}

function linear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map(linear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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

/** An `rgba()` tint composited over an opaque hex — what a chip really is. */
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

/** Everything a label, glyph or border may be drawn in. */
const SEMANTICS = ['success', 'warning', 'danger', 'info'] as const;

describe('the semantic colours stay legible on both of their grounds', () => {
  /* `bg` and `surface` are different tones and a colour is drawn on both, so
     the weaker of the two is the one that decides. Checking only `bg` is how a
     chip passes here and fails on the card it actually sits in. */
  for (const [name, colors] of Object.entries(SCHEMES)) {
    for (const token of SEMANTICS) {
      it(`${name} ${token}`, () => {
        expect(contrast(colors[token], colors.bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(colors[token], colors.surface)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe('the room stays quiet', () => {
  /* The ground is allowed its full chroma because it is nearly white and reads
     as a tint. A mid-lightness colour at the same saturation does not — that is
     the difference between a warm room and a sticker on one.

     The ceiling is on the colours that are *not* the brand. Two of the four
     semantics now resolve to `accent` itself, and holding the identity to a
     saturation ceiling would be this rule quietly redesigning the product it
     was written to protect. What holds the accent honest is contrast, below and
     in `theme.test.ts`, which is the thing a reader actually experiences. */
  for (const [name, colors] of Object.entries(SCHEMES)) {
    it(`${name}: no semantic colour shouts`, () => {
      for (const token of SEMANTICS) {
        if (colors[token] === colors.accent) continue;
        expect(hsl(colors[token]).sat).toBeLessThanOrEqual(80);
      }
    });
  }

  /* Not a hard ceiling on the brand: `accent` is the identity and `heat.core`
     is meant to be vivid. This only pins that the vivid one stays *out* of the
     text-safe slot, which is the rule the file opens with. */
  it('accent is the darkened ember, not the hot one', () => {
    for (const [name, colors] of Object.entries(SCHEMES)) {
      expect(colors.accent).not.toBe(heat[name as 'light' | 'dark'].core);
      expect(contrast(colors.accent, colors.bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('the palette holds two temperatures', () => {
  /* This replaces a rule that required all four semantics to be more than 20°
     apart in hue, and the rule was the defect rather than a guard against it.
     Four hues on a warm ground is four things to learn, and what shipped under
     it was 8°, 34°, 150° and 193° — `danger` five degrees from the brand, a
     `warning` that read as dirty orange, and a green and a blue shouting from
     the far side of the wheel. Separation was measured; meaning never was.

     What replaces it is one distinction the vernacular already carries: warm is
     live, yours, needs you; cool is settled, kept, done. `success` and `info`
     were never two ideas, so they are one colour, and `warning` is the ember
     itself because a warning in this app *is* the thing being pointed at. */
  for (const [name, colors] of Object.entries(SCHEMES)) {
    it(`${name}: says the same thing with the same colour`, () => {
      expect(colors.info).toBe(colors.success);
      expect(colors.warning).toBe(colors.accent);
    });

    it(`${name}: spends no more than three inks on five tokens`, () => {
      const inks = new Set([colors.accent, ...SEMANTICS.map((token) => colors[token])]);
      expect(inks.size).toBeLessThanOrEqual(3);
    });

    /* `danger` is the one that must not be resolved by hue, because it is warm
       on purpose — a cool "stop" on a warm ground reads as information, not as
       a hazard. It separates by *weight*: darker and deeper than the accent in
       light, lighter and softer in dark, which is the direction each scheme
       has left to travel. Severity is carried by how heavy the ink is, and that
       survives being seen by somebody who cannot separate the two hues at all. */
    it(`${name}: separates danger from the accent by weight, not by hue`, () => {
      const apart = Math.abs(lightness(colors.danger) - lightness(colors.accent));
      expect(apart).toBeGreaterThan(8);
      const warm = hsl(colors.danger).hue;
      expect(warm < 40 || warm > 340).toBe(true);
    });
  }
});

describe('a tinted chip is read against its own tint', () => {
  /* Every muted token is paint over a card, so the ground a label actually has
     is the composite — and because the tint is built from the colour, a token
     too light to read is doubly too light there. Nothing measured it, and that
     is how a chip shipped at 2.45:1 with every contrast rule in this file
     green: they were all checking a ground the chip is never drawn on. */
  for (const [name, colors] of Object.entries(SCHEMES)) {
    it(`${name}: every semantic clears its own chip`, () => {
      for (const token of SEMANTICS) {
        const chip = over(colors[`${token}Muted`], colors.surface);
        expect(contrast(colors[token], chip)).toBeGreaterThanOrEqual(4.5);
      }
      const accentChip = over(colors.accentMuted, colors.surface);
      expect(contrast(colors.accent, accentChip)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('the categorical ramp', () => {
  /* The one place a colour is allowed to be arbitrary, because there it is the
     *channel*: a timetable of subjects, a month of event dots, a column of
     avatars — many peers on one screen with no other mark telling them apart.
     Everywhere else it was decoration on something already named in words, and
     the ramp does not go there any more.

     It is exercised through `colorForTag` because `TAG_TINTS` is private, and
     200 words is far more than enough to see all of it. */
  for (const [name, colors] of Object.entries(SCHEMES)) {
    const scheme = name as 'light' | 'dark';
    const ramp = [
      ...new Set(Array.from({ length: 200 }, (_, i) => colorForTag(`tag-${i}`, scheme))),
    ];

    it(`${name}: is a set, not a wheel`, () => {
      // Small enough to read as one family. A palette that keeps growing by one
      // hue per feature is the thing this whole rewrite was for.
      expect(ramp.length).toBeGreaterThan(1);
      expect(ramp.length).toBeLessThanOrEqual(6);
    });

    it(`${name}: is legible everywhere it is drawn`, () => {
      for (const tint of ramp) {
        for (const ground of [colors.bg, colors.surface, colors.surfaceSunken]) {
          expect(contrast(tint, ground)).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(tint, over(plateOf(tint, scheme), colors.surface))).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    });

    /* Members of a categorical set have to be *equally* loud. One that is much
       lighter than the rest reads as selected rather than as a fifth category —
       which is what a 32° gold did against four colours 5 L* apart. */
    it(`${name}: gives no member more weight than the others`, () => {
      const levels = ramp.map(lightness);
      expect(Math.max(...levels) - Math.min(...levels)).toBeLessThanOrEqual(8);
    });

    /* The ramp's warm end lives in the same family as the accent and should —
       it is the ember's palette. What it must not do is *be* the accent token,
       or a change to the brand colour silently makes one whole category
       indistinguishable from the app talking about itself. */
    it(`${name}: keeps out of the accent's slot`, () => {
      expect(ramp).not.toContain(colors.accent);
    });
  }
});

/** The alpha `plateOf` uses, restated so the test is not reading the source. */
function plateOf(hex: string, scheme: 'light' | 'dark'): string {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${scheme === 'dark' ? 0.16 : 0.12})`;
}

describe('nothing is neutral grey', () => {
  /* The rule `theme.ts` opens with. A true grey has no hue to check, so this
     asks the only question that has an answer: is there any chroma at all. */
  for (const [name, colors] of Object.entries(SCHEMES)) {
    it(`${name}: every solid colour carries a hue`, () => {
      const solids = Object.entries(colors).filter(
        ([, value]) => typeof value === 'string' && value.startsWith('#'),
      );
      expect(solids.length).toBeGreaterThan(5);
      // Collected rather than asserted one at a time, so a failure names every
      // grey at once and the hue it was missing.
      const greys = solids
        .map(([token, value]) => ({ token, sat: Math.round(hsl(value as string).sat) }))
        .filter((entry) => entry.sat <= 4);
      expect(greys).toEqual([]);
    });
  }
});
