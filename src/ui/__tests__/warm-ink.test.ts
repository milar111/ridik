/**
 * No cold colour in a warm room.
 *
 * `theme.ts` opens with the rule — every "white" is linen, every "black" is a
 * warm brown, and a true grey next to this palette reads as a bug — and
 * `palette.test.ts` enforces it on the *tokens*. Nothing enforced it on the
 * places that ignore the tokens, and two whole families had drifted in:
 *
 *  - seven `#FFFFFF` inks drawn on accent and success fills, which are also the
 *    only real *contrast* bug of the pair. `colors.accent` is pale in dark mode
 *    (#FF8253) and `colors.success` paler still (#51C68A); white on them
 *    measured 2.45:1 and 2.15:1, so the tick you press every day was the least
 *    legible glyph in the app on the scheme most people run.
 *  - a Tailwind-ish cold-grey stylesheet in the HTML export — #16181d, #e3e5ea,
 *    #6b7280, #f5f6f8 — which is the app's voice in a document somebody else
 *    reads.
 *
 * Both were found by eye, twice. This is so there is not a third time. It reads
 * the source rather than rendering, because that is what the failure is: a
 * literal, written by hand, in a file with a token sitting right next to it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { markdownToHtml } from '@/features/export/markdown';
import { inkOn, LINEN, SOOT } from '@/ui/ink';
import { colorForTag, darkColors, embers, lightColors, type Colors } from '@/ui/theme';

const ROOT = resolve(__dirname, '..', '..', '..');

/* ------------------------------------------------------------- colour maths -- */

function rgb(hex: string): [number, number, number] {
  const digits = hex.slice(1);
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((d) => d + d)
          .join('')
      : digits;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** Accepts what the stylesheet can hold: `#rgb`, `#rrggbb`, `rgb()`, `rgba()`. */
function channels(color: string): [number, number, number] {
  if (color.startsWith('#')) return rgb(color);
  const inside = /^rgba?\(([^)]+)\)$/i.exec(color.trim())![1]!;
  const parts = inside.split(',').map((p) => Number(p.trim()));
  return [parts[0]! / 255, parts[1]! / 255, parts[2]! / 255];
}

function hsl(color: string): { hue: number; sat: number } {
  const [r, g, b] = channels(color);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { hue: 0, sat: 0 };
  const sat = delta / (1 - Math.abs(2 * light - 1));
  const hue =
    max === r
      ? 60 * (((g - b) / delta) % 6)
      : max === g
        ? 60 * ((b - r) / delta + 2)
        : 60 * ((r - g) / delta + 4);
  return { hue: ((hue % 360) + 360) % 360, sat: sat * 100 };
}

function linear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(color: string): number {
  const [r, g, b] = channels(color).map(linear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * Composites a translucent ink over its ground, because a bare `rgba()` cannot
 * be measured for contrast — `textSecondary` is 74% of a brown over the paper,
 * and reading only its channels would score it as if it were opaque.
 */
function over(color: string, ground: string): string {
  const alpha = /^rgba\(([^)]+)\)$/i.exec(color.trim());
  if (!alpha) return color;
  const parts = alpha[1]!.split(',').map((p) => Number(p.trim()));
  const a = parts.length > 3 ? parts[3]! : 1;
  const base = channels(ground).map((c) => c * 255);
  const mixed = [parts[0]!, parts[1]!, parts[2]!].map((c, i) =>
    Math.round(c * a + base[i]! * (1 - a)),
  );
  return `rgb(${mixed.join(', ')})`;
}

/* ---------------------------------------------------------------- the scan -- */

const SOURCE_ROOTS = ['src', 'app'];
const SKIP_DIRS = new Set(['__tests__', '__snapshots__', 'node_modules']);

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) sources(full, found);
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

/**
 * Prose is not a colour. `theme.ts` and `shadow.ts` both discuss `"white"` in
 * their own comments, and a scan that cannot tell the difference is one that
 * gets an exception added to it the first time it is inconvenient.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Opaque pure white, in the three ways this codebase could write one. An
 * eight-digit `#AARRGGBB` is left alone on purpose: `depth.wellFloor` is white
 * at 70% and the Android mic vector is drawn white *to be tinted*, and neither
 * is an ink.
 */
const PURE_WHITE = [
  /#(?:fff|ffffff)\b/i,
  /(['"])white\1/,
  /rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(?:,\s*1(?:\.0+)?\s*)?\)/i,
];

describe('no pure white ink', () => {
  it('nothing under src/ or app/ writes an opaque #FFFFFF', () => {
    const offenders: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of sources(join(ROOT, root))) {
        const code = stripComments(readFileSync(file, 'utf8'));
        code.split('\n').forEach((line, i) => {
          if (PURE_WHITE.some((pattern) => pattern.test(line))) {
            offenders.push(`${relative(ROOT, file).split(sep).join('/')}:${i + 1} ${line.trim()}`);
          }
        });
      }
    }
    // Collected rather than asserted per file, so a failure names every one at
    // once and shows the line it is on.
    expect(offenders).toEqual([]);
  });

  it('the two inks it chooses between are the palette’s own', () => {
    expect(LINEN).toBe(embers.ember.light.onHeat);
    expect(SOOT).toBe(embers.ember.dark.onHeat);
    // Linen is warm and off-white; soot is a warm brown, not a black.
    expect(hsl(LINEN).sat).toBeGreaterThan(4);
    expect(hsl(SOOT).sat).toBeGreaterThan(4);
    for (const ink of [LINEN, SOOT]) expect(hsl(ink).hue).toBeLessThanOrEqual(60);
  });
});

/* --------------------------------------------------------------- contrast -- */

/**
 * Every token that can end up *as a fill* with ink on it. `accent` is the
 * button and both calendar pills, `success` is the task tick, and any of the
 * five can be handed to a selected `Chip` as its tint.
 */
function filledSurfaces(colors: Colors): { name: string; fill: string }[] {
  return [
    { name: 'accent', fill: colors.accent },
    { name: 'success', fill: colors.success },
    { name: 'warning', fill: colors.warning },
    { name: 'danger', fill: colors.danger },
    { name: 'info', fill: colors.info },
  ];
}

describe('ink on a fill clears 4.5:1', () => {
  /* The bug the swap was there to fix, stated as arithmetic. A constant white
     passes this in light and fails it in dark, which is exactly how it shipped. */
  for (const [scheme, colors] of Object.entries({ light: lightColors, dark: darkColors })) {
    for (const { name, fill } of filledSurfaces(colors)) {
      it(`${scheme} ${name}`, () => {
        expect(contrast(inkOn(fill), fill)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('and on every ember’s accent, in both schemes', () => {
    for (const option of Object.values(embers)) {
      for (const scheme of ['light', 'dark'] as const) {
        const fill = option[scheme].hot;
        expect(contrast(inkOn(fill), fill)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('and on every tag tint, which does not follow the scheme', () => {
    // `TAG_COLORS` is private; 200 tags is far more than enough to see all of it.
    const tints = new Set(Array.from({ length: 200 }, (_, i) => colorForTag(`tag-${i}`, 'light')));
    expect(tints.size).toBeGreaterThan(1);
    for (const tint of tints) {
      expect(contrast(inkOn(tint), tint)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('an unreadable fill falls back rather than throwing', () => {
    expect(inkOn('transparent')).toBe(LINEN);
    expect(inkOn('')).toBe(LINEN);
  });
});

/* ------------------------------------------------------ the export document -- */

const STYLESHEET = /<style>([\s\S]*?)<\/style>/.exec(markdownToHtml('# Report'))![1]!;

/** Every colour the stylesheet sets, in source order. */
function stylesheetColors(css: string): string[] {
  return css.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]+\)/gi) ?? [];
}

describe('the export speaks in the app’s own palette', () => {
  it('states every colour it draws', () => {
    // A guard that silently matched nothing would pass for ever.
    expect(stylesheetColors(STYLESHEET).length).toBeGreaterThanOrEqual(6);
  });

  it('carries no cold neutral', () => {
    const cold = stylesheetColors(STYLESHEET)
      .map((color) => ({ color, ...hsl(color) }))
      // Warm is the palette's 0–60° band. A colour with no chroma at all is the
      // other half of the rule — that is what #f5f6f8 and #FFFFFF both are.
      .filter(({ hue, sat }) => sat <= 4 || hue > 60);
    expect(cold).toEqual([]);
  });

  it('carries no pure white', () => {
    for (const pattern of PURE_WHITE) expect(pattern.test(STYLESHEET)).toBe(false);
  });

  it('is still legible as a printed page', () => {
    const paper = lightColors.surface;
    expect(contrast(over(lightColors.text, paper), paper)).toBeGreaterThanOrEqual(4.5);
    // `em` is the quietest ink in the document and the one a cold grey was
    // hiding in; it carries real sentences, so it is held to body contrast.
    expect(contrast(over(lightColors.textSecondary, paper), paper)).toBeGreaterThanOrEqual(4.5);
    const header = lightColors.surfaceSunken;
    expect(contrast(over(lightColors.text, header), header)).toBeGreaterThanOrEqual(4.5);
  });

  it('declares itself a light surface, because paper has one temperature', () => {
    expect(STYLESHEET).toContain('color-scheme: light');
  });
});
