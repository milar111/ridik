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
import { darkColors, heat, lightColors } from '../theme';

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
     the difference between a warm room and a sticker on one. */
  for (const [name, colors] of Object.entries(SCHEMES)) {
    it(`${name}: no semantic colour shouts`, () => {
      for (const token of SEMANTICS) {
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
      expect(contrast(colors.accent, colors.bg)).toBeGreaterThanOrEqual(4.4);
    }
  });
});

describe('the semantics remain tellable apart', () => {
  /* Calming them moved all four toward each other. Far enough and "done" and
     "overdue" become the same swatch, which costs more than the vibrancy did. */
  for (const [name, colors] of Object.entries(SCHEMES)) {
    it(`${name}: every pair separates by hue`, () => {
      for (let i = 0; i < SEMANTICS.length; i++) {
        for (let j = i + 1; j < SEMANTICS.length; j++) {
          const a = hsl(colors[SEMANTICS[i]!]).hue;
          const b = hsl(colors[SEMANTICS[j]!]).hue;
          const apart = Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
          expect(apart).toBeGreaterThan(20);
        }
      }
    });
  }
});

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
