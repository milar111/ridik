/**
 * The numbers that exist in three places each, and had nothing holding them.
 *
 * A widget's geometry cannot be shared code. An Xcode extension links neither
 * the app nor React Native, `RemoteViews` cannot read a measured height back, and
 * the Android layouts are XML written by a config plugin — so a size a face draws
 * at is stated once per platform, and the platforms have to agree by hand.
 *
 * AGENTS.md has listed these as "four numbers that have to agree across four
 * files, and nothing fails loudly when they do not" for as long as they have
 * existed. This is the thing that fails loudly. It was written the day two of
 * them moved at once — `PLOT_HEIGHT.route` from 30 to 44 and `RING_DP` from 56 to
 * 42 — because that is exactly the change that leaves one file behind and shows
 * up months later as a clipped tile on one platform only.
 *
 * Read from the shipped artifacts, never from a copy: the Swift as text, the
 * Kotlin as text, the Android XML by calling the plugin that writes it. An
 * assertion that reads something other than what ships is the failure mode
 * `widget-tokens.test.ts` documents at length, and it applies here identically.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');

const SWIFT_PLOTS = readFileSync(
  join(ROOT, 'targets', 'RidikWidget', 'RidikPlotViews.swift'),
  'utf8',
);
const SWIFT_RINGS = readFileSync(
  join(ROOT, 'targets', 'RidikWidget', 'RidikRingsView.swift'),
  'utf8',
);
const KOTLIN_FACE = readFileSync(
  join(
    ROOT,
    'modules/ridik-widgets/android/src/main/java/ai/dby/ridik/widgets/RidikRowsFace.kt',
  ),
  'utf8',
);
const SWIFT_CHAIN = readFileSync(
  join(ROOT, 'targets', 'RidikWidget', 'RidikChainView.swift'),
  'utf8',
);
const KOTLIN_RINGS = readFileSync(
  join(ROOT, 'modules/ridik-widgets/android/src/main/java/ai/dby/ridik/widgets/RidikRings.kt'),
  'utf8',
);
const KOTLIN_PLOTS = readFileSync(
  join(ROOT, 'modules/ridik-widgets/android/src/main/java/ai/dby/ridik/widgets/RidikPlots.kt'),
  'utf8',
);
const PLUGIN = readFileSync(join(ROOT, 'plugins', 'withRidikAndroidWidget.js'), 'utf8');

/** One capture group, and a failure that names the file rather than "undefined". */
function grab(source: string, label: string, pattern: RegExp): string {
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`${label} not found — pattern ${pattern} no longer matches`);
  return match[1];
}

describe('the route plot height agrees in all three places', () => {
  /**
   * 30 was too short twice over: the line is a ratio of its own box, so 30 drew a
   * hairline, and the ~50 points a medium tile had spare all went into one hole
   * between the line and its caption.
   */
  const EXPECTED = 44;

  it('is what the iOS face asks for', () => {
    const swift = grab(
      SWIFT_PLOTS,
      'RidikRouteView height',
      /shape:\s*\.route,\s*height:\s*(\d+)/,
    );
    expect(Number(swift)).toBe(EXPECTED);
  });

  it('is what the Android plugin writes into the layout', () => {
    const plugin = grab(PLUGIN, 'PLOT_HEIGHT.route', /route:\s*\{\s*medium:\s*(\d+)\s*\}/);
    expect(Number(plugin)).toBe(EXPECTED);
  });

  it('is what the Android provider rasters at', () => {
    const kotlin = grab(KOTLIN_FACE, 'plotHeightDp ROUTE', /Kind\.ROUTE\s*->\s*(\d+)/);
    expect(Number(kotlin)).toBe(EXPECTED);
  });
});

describe('the route line is the same fraction of its box on both platforms', () => {
  /**
   * A ratio rather than a capped absolute, deliberately. Both platforms size
   * every ornament from the box it is drawn in, so one shared fraction cannot
   * drift the way `min(h * 0.34, 12)` against a hard `12f` would the moment the
   * box was retuned.
   */
  it('is 0.27 in Swift and in Kotlin', () => {
    expect(grab(SWIFT_PLOTS, 'Swift route thickness', /let thick = h \* ([\d.]+)/)).toBe('0.27');
    expect(grab(KOTLIN_PLOTS, 'Kotlin route thickness', /val thick = height \* ([\d.]+)f/)).toBe(
      '0.27',
    );
  });

  /**
   * The track under the day, at the same alpha on both. Without it the whole
   * morning of an ordinary day drew as blank ground: a spent empty cell is
   * 0.18 * 0.55, which is ten per cent of an ember four points tall, which is
   * nothing. The face read as a slider rather than a journey.
   */
  it('lays a track at 0.13 on both', () => {
    expect(SWIFT_PLOTS).toMatch(/palette\.accent\.opacity\(0\.13\)/);
    expect(KOTLIN_PLOTS).toMatch(/paint\.alpha = \(0\.13f \* 255\)\.toInt\(\)/);
  });
});

describe('the ring geometry agrees across the three files that state it', () => {
  /**
   * 42, down from 56. Two rows of a 56 ring with an 11pt name *under* it asked
   * for about 189 points of the 130 a medium tile has, and both platforms clip in
   * silence — which is how the face shipped with its header off the top edge and
   * its second row of names off the bottom.
   */
  const DIAMETER = 42;
  const STROKE = 4.5;

  it('is 42 across in Swift and in the Android layout', () => {
    const swift = grab(SWIFT_RINGS, 'Ring.diameter', /static let diameter: CGFloat = ([\d.]+)/);
    expect(Number(swift)).toBe(DIAMETER);
    const plugin = grab(PLUGIN, 'RING_DP', /const RING_DP = (\d+);/);
    expect(Number(plugin)).toBe(DIAMETER);
  });

  it('strokes at the same fraction of that diameter everywhere', () => {
    const swift = Number(
      grab(SWIFT_RINGS, 'Ring.stroke', /static let stroke: CGFloat = ([\d.]+)/),
    );
    expect(swift).toBe(STROKE);

    // Kotlin states the ratio; the plugin states it against a 100-unit viewport.
    const kotlin = grab(
      KOTLIN_RINGS,
      'STROKE_RATIO',
      /STROKE_RATIO = ([\d.]+)f \/ ([\d.]+)f/,
    );
    const kotlinPair = KOTLIN_RINGS.match(/STROKE_RATIO = ([\d.]+)f \/ ([\d.]+)f/)!;
    expect(Number(kotlinPair[1]) / Number(kotlinPair[2])).toBeCloseTo(STROKE / DIAMETER, 6);
    expect(kotlin).toBe(String(STROKE));

    const pluginPair = PLUGIN.match(/const RING_STROKE = \(RING_VIEWPORT \* ([\d.]+)\) \/ (\d+);/)!;
    expect(pluginPair).not.toBeNull();
    expect(Number(pluginPair[1]) / Number(pluginPair[2])).toBeCloseTo(STROKE / DIAMETER, 6);
  });

  /**
   * The raster is a fixed generous square scaled with `fitCenter`, so it only has
   * to be a whole multiple of the view — 168 is 4x of 42, which is the densest
   * launcher getting whole pixels.
   */
  it('rasters at a whole multiple of the view it is scaled into', () => {
    const px = Number(grab(KOTLIN_FACE, 'RING_PX', /RING_PX = (\d+)/));
    expect(px % DIAMETER).toBe(0);
  });
});

describe('the ring slot count agrees', () => {
  it('is six on medium in Swift, Kotlin and the plugin', () => {
    expect(SWIFT_RINGS).toMatch(/family == \.systemSmall \? 2 : 6/);
    expect(KOTLIN_FACE).toMatch(/WidgetSize\.SMALL -> 2/);
    expect(PLUGIN).toMatch(/RING_SLOTS_BY_SIZE = \{ small: 2, medium: 6, large: 6 \}/);
  });
});

/**
 * Week is the one face where the two platforms deliberately take *different*
 * approaches to reach the same result, and this used to assert they took the
 * same one.
 *
 * A medium content box is 312 x 130 on iOS. An Android two-row tile is 215dp on
 * a Galaxy S23 and about 240 on a Pixel — the same face, nearly twice the
 * height. A fixed 68 is exactly right in the first box and leaves a dead band
 * across the bottom third of the second, which is what the picker card was
 * showing. There is no number that is right on both, so Swift keeps its
 * measured 68 and the Android bar became a `layout_weight`.
 *
 * This is the same trade `SHEET` makes in `app/_layout.tsx`: matching the
 * *option* is what produced two different screens, and matching the *result*
 * needed two options. So what is pinned here is no longer a shared number —
 * it is that neither side has quietly reverted to the other's approach.
 */
describe('the week column fills its box on Android and fits its box on iOS', () => {
  it('keeps the measured 68 on iOS, where the box really is 130', () => {
    const swift = grab(
      SWIFT_CHAIN,
      'Chain day height (medium)',
      // Two ternaries on one line; this is the *second* parenthesised branch.
      /height: small \? \([^)]*\) : \(clear == 7 \? \d+ : (\d+)\)/,
    );
    expect(Number(swift)).toBe(68);
  });

  it('weights the Android bar rather than fixing it', () => {
    // The bar, its column and the chain that holds them must all be weighted:
    // a weighted child inside a `wrap_content` parent resolves to nothing, so
    // any one of the three reverting to a fixed height brings the band back.
    const chain = /function chainRow\([\s\S]*?\n}/.exec(PLUGIN)?.[0];
    expect(chain).toBeDefined();
    expect(chain).not.toMatch(/CHAIN_HEIGHT/);
    expect(chain!.match(/android:layout_weight="1"/g)?.length).toBeGreaterThanOrEqual(3);
    // And nothing may be parked under it again — `slack` there is the band.
    const face = /function chainFace\([\s\S]*?\n}/.exec(PLUGIN)?.[0];
    expect(face).toBeDefined();
    expect(face).not.toMatch(/slack\(/);
  });

  /**
   * A column is 9 + 3 + bar + 3 + 10, and the header with its padding is 27. The
   * whole thing has to clear the 130-point content box of a medium tile with
   * something left for a user who has scaled their type up.
   */
  it('leaves the medium column inside the tile it is drawn in', () => {
    const COLUMN = 11 + 3 + 68 + 3 + 12;
    const HEADER = 17 + 10;
    expect(COLUMN + HEADER).toBeLessThanOrEqual(130);
  });
});

describe('the week eyebrow is shortened on small in all three places', () => {
  /** "THIS WEEK" truncated to "THIS W…" on a 130-point tile. */
  it('says WEEK on small and THIS WEEK otherwise', () => {
    expect(SWIFT_CHAIN).toMatch(/small \? "WEEK" : "THIS WEEK"/);
    expect(KOTLIN_FACE).toMatch(/if \(size == WidgetSize\.SMALL\) "WEEK" else "THIS WEEK"/);
    expect(PLUGIN).toMatch(/size === 'small' \? 'WEEK'/);
  });
});
