/**
 * How small a launcher may let a tile get, and why it is not one number.
 *
 * A widget's resize floor is the only thing standing between a face and a box
 * it cannot draw in. Every provider used to declare the same
 * `minResizeWidth="140dp"` and `minResizeHeight="110dp"`, which bore no relation
 * to any face: the Kotlin reports `SMALL` below `MEDIUM_MIN_DP`, and the five
 * faces with no small layout are floored back to medium — so a 4-wide Sundial
 * could be dragged down to 140dp and the medium layout was drawn into it
 * anyway. Reported from a Galaxy S23, where one corner-drag produced an arc
 * squeezed into a third of its width.
 *
 * Two agreements are asserted here and neither is checkable by reading one
 * file: the plugin's `MEDIUM_MIN_DP` against the Kotlin's, and every generated
 * provider against the face's own declared `sizes`.
 *
 * Reads the generated XML rather than the plugin's source, for the reason
 * `widget-tokens.test.ts` gives at length. Skips when `android/` has not been
 * generated, as `widget-target-sync.test.ts` skips without `ios/`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const XML = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'xml');
const PLUGIN = readFileSync(join(ROOT, 'plugins', 'withRidikAndroidWidget.js'), 'utf8');
const KOTLIN = readFileSync(
  join(ROOT, 'modules/ridik-widgets/android/src/main/java/ai/dby/ridik/widgets/RidikCells.kt'),
  'utf8',
);

/** Faces with no `small` layout — the Kotlin floors each of these to medium. */
function mediumOnlyKinds(): string[] {
  const kinds: string[] = [];
  const re = /kind: '([a-z]+)',[\s\S]*?sizes: \[([^\]]*)\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(PLUGIN)) !== null) {
    if (!match[2]!.includes('small')) kinds.push(match[1]!);
  }
  return kinds;
}

const present = existsSync(XML);
/**
 * By content, not by filename: the plugin also writes `ridik_backup_rules.xml`
 * into this directory, which is an Android backup manifest and has no widget
 * geometry in it at all.
 */
const providers = present
  ? readdirSync(XML).filter(
      (f) =>
        f.startsWith('ridik_') &&
        readFileSync(join(XML, f), 'utf8').includes('<appwidget-provider'),
    )
  : [];

const attr = (xml: string, name: string): number =>
  Number(new RegExp(`android:${name}="(\\d+)dp"`).exec(xml)?.[1] ?? NaN);

(present ? describe : describe.skip)('the widget resize floors', () => {
  it('agrees with the Kotlin about where a medium face stops being drawable', () => {
    const kotlin = /private const val MEDIUM_MIN_DP = (\d+)/.exec(KOTLIN)?.[1];
    const plugin = /const MEDIUM_MIN_DP = (\d+);/.exec(PLUGIN)?.[1];

    expect(kotlin).toBeDefined();
    expect(plugin).toBeDefined();
    // The whole point: below this width the Kotlin has no narrower file to
    // reach for. A launcher must never be told it may go there.
    expect(Number(plugin)).toBe(Number(kotlin));
  });

  it('never lets a face without a small layout be squeezed below medium', () => {
    const floor = Number(/const MEDIUM_MIN_DP = (\d+);/.exec(PLUGIN)![1]);
    const kinds = mediumOnlyKinds();

    // Five today: rings, nownext, horizon, sundial, route. Asserted as a count
    // so that adding a sixth medium-only face has to come past this line.
    expect(kinds.length).toBeGreaterThanOrEqual(5);

    for (const kind of kinds) {
      const file = providers.find((f) => f.includes(`_${kind}_info`));
      expect(file).toBeDefined();
      const xml = readFileSync(join(XML, file!), 'utf8');
      expect({ kind, min: attr(xml, 'minResizeWidth') }).toEqual({ kind, min: floor });
    }
  });

  /**
   * Height has no small variant at all — `sizeOf` only ever promotes on height,
   * never demotes — so a face squeezed vertically does not switch to something
   * simpler, it collapses. The calendar's month grid rendered as one empty band
   * that way.
   */
  it('never lets a tile be shorter than the rows it was placed at', () => {
    for (const file of providers) {
      const xml = readFileSync(join(XML, file), 'utf8');
      const rows = attr(xml, 'targetCellHeight');
      if (!Number.isFinite(rows)) continue;
      expect({ file, min: attr(xml, 'minResizeHeight') }).toEqual({ file, min: rows * 55 });
      // And the floor is never above the size the launcher places it at, or the
      // tile arrives already smaller than it is allowed to be.
      expect(attr(xml, 'minResizeHeight')).toBeLessThanOrEqual(attr(xml, 'minHeight'));
    }
  });

  it('never declares a width floor above the width it asks to be placed at', () => {
    for (const file of providers) {
      const xml = readFileSync(join(XML, file), 'utf8');
      expect({ file, ok: attr(xml, 'minResizeWidth') <= attr(xml, 'minWidth') }).toEqual({
        file,
        ok: true,
      });
    }
  });

  /**
   * The ceiling half. Every provider declared `maxResize* = 800dp`, which is no
   * ceiling on any phone, and a Sundial dragged to 359dp tall drew its 128dp arc
   * with 200dp of bare ground under it — the plots pin their own height on
   * purpose, so height above the declared grid buys nothing but air.
   */
  it('agrees with the Kotlin about where rails promote on width', () => {
    const kotlin = /private const val RAILS_LARGE_DP = (\d+)/.exec(KOTLIN)?.[1];
    const plugin = /const RAILS_LARGE_DP = (\d+);/.exec(PLUGIN)?.[1];
    expect(kotlin).toBeDefined();
    expect(plugin).toEqual(kotlin);
  });

  it('never lets a face be stretched past the grid it declares', () => {
    for (const file of providers) {
      const xml = readFileSync(join(XML, file), 'utf8');
      const rows = attr(xml, 'targetCellHeight');
      if (!Number.isFinite(rows)) continue;
      // Two cells of headroom only where a `large` layout exists to use it.
      // `minResizeHeight` is `rows * 55`, so the ratio is what tells them apart.
      const headroom = attr(xml, 'maxResizeHeight') / 110 - rows;
      expect({ file, headroom }).toEqual({ file, headroom: headroom === 0 ? 0 : 2 });
    }
  });

  it('never declares a ceiling below its own floor or its own placement', () => {
    for (const file of providers) {
      const xml = readFileSync(join(XML, file), 'utf8');
      for (const [ceil, floor, placed] of [
        ['maxResizeHeight', 'minResizeHeight', 'minHeight'],
        ['maxResizeWidth', 'minResizeWidth', 'minWidth'],
      ] as const) {
        expect({
          file,
          ceil,
          ok: attr(xml, ceil) >= attr(xml, floor) && attr(xml, ceil) >= attr(xml, placed),
        }).toEqual({ file, ceil, ok: true });
      }
    }
  });

  /**
   * The picker inflates `previewLayout` at the tile's *declared* size, so a
   * preview built at any other size advertises a composition nobody is shown.
   * Now/Next declared `['medium', 'large']` and previewed at `medium`, and a
   * 4 x 2 tile clears `LARGE_MIN_DP` everywhere — so the card carried a medium
   * face in a large box with the weighted spacer taking the difference as one
   * dead band across the middle of it.
   */
  it('previews every face at the largest size it declares', () => {
    const re = /kind: '([a-z]+)'[\s\S]*?sizes: \[([^\]]*)\][\s\S]*?previewSize: '([a-z]+)'/g;
    const seen: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(PLUGIN)) !== null) {
      const declared = match[2]!.split(',').map((s) => s.trim().replace(/'/g, ''));
      seen.push(match[1]!);
      expect({ kind: match[1], preview: match[3] }).toEqual({
        kind: match[1],
        preview: declared[declared.length - 1],
      });
    }
    // The regex is the assertion's weakest part: a rename that stopped it
    // matching would pass silently with nothing checked.
    expect(seen.length).toBe(providers.length);
  });

  it('holds the rails face below the width that would promote it to large', () => {
    const xml = readFileSync(join(XML, 'ridik_rows_habits_info.xml'), 'utf8');
    const rails = Number(/private const val RAILS_LARGE_DP = (\d+)/.exec(KOTLIN)![1]);
    // Habits has no large layout — six rails cannot grow to meet one — so it
    // must never be resized into the width that asks the Kotlin for it.
    expect(attr(xml, 'maxResizeWidth')).toBeLessThan(rails);
  });
});

/**
 * The rule the picker taught, the hard way, three times.
 *
 * A widget layout is inflated into a box nobody here chose: the launcher's grid,
 * on the buyer's phone. A Pixel gives a 4 x 2 tile about 240dp, a Galaxy S23
 * gives 215, and One UI's *picker card* for the same tile gives about 174. A
 * face built around a fixed-height graphic is therefore wrong on two of those
 * three, and wrong in opposite directions — it leaves a dead band where the box
 * is tall and, where the box is short, `LinearLayout` pays the rigid child first
 * and whatever came last falls off the bottom. Sundial and Skyline both shipped
 * to the picker with no caption at all for that reason, and Week shipped with a
 * third of its card empty.
 *
 * So every face's graphic is a weighted child. It cannot overflow, because it
 * yields before the text does, and it cannot leave a hole, because it takes
 * whatever the text did not. What the graphic *does* with the room is a
 * `scaleType` — a field fills, a shape keeps its aspect — which is a property of
 * the drawing, not a guess about the device.
 *
 * Read from the generated layouts rather than the plugin, because the layouts
 * are what ship, and skipped when `android/` has not been generated.
 */
(present ? describe : describe.skip)('no face pins its graphic to a fixed height', () => {
  const LAYOUT = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout');

  /** The block of attributes belonging to the view with this id. */
  function view(xml: string, id: string): string | null {
    const at = xml.indexOf(`android:id="@+id/${id}"`);
    if (at === -1) return null;
    const end = xml.indexOf('/>', at);
    return xml.slice(at, end === -1 ? undefined : end);
  }

  // A skipped describe still runs its body to collect the tests, so the read
  // has to be guarded as well as the block — on a checkout with no `android/`
  // an unguarded `readdirSync` fails the whole suite rather than skipping it.
  const layouts = existsSync(LAYOUT)
    ? readdirSync(LAYOUT).filter((f) => f.startsWith('ridik_') && f.endsWith('.xml'))
    : [];

  // Every graphic that is a whole face's picture. A row of text may be
  // `wrap_content` — it is the thing the graphic is yielding *to*.
  for (const id of ['ridik_plot', 'ridik_chain_0']) {
    it(`keeps ${id} elastic in every layout that has one`, () => {
      const seen: string[] = [];
      for (const file of layouts) {
        const block = view(readFileSync(join(LAYOUT, file), 'utf8'), id);
        if (!block) continue;
        seen.push(file);
        expect({ file, id, height: /android:layout_height="([^"]*)"/.exec(block)?.[1] }).toEqual({
          file,
          id,
          height: '0dp',
        });
        expect(block).toMatch(/android:layout_weight="1"/);
      }
      // A rename that stopped the id matching would pass with nothing checked.
      expect(seen.length).toBeGreaterThan(0);
    });
  }
});

/**
 * `fitXY` scales the two axes independently, so on any box that is off the
 * graphic's own aspect it turns every round thing into an ellipse. Term is a
 * field of dots and drew a grid of eggs; Route's puck had been an ellipse for
 * the same reason for as long as the face has existed. Only a graphic made of
 * rectangles may fill both axes.
 */
(present ? describe : describe.skip)('only a field of rectangles is allowed to stretch', () => {
  const LAYOUT = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout');
  /** Skyline. Its bars are the datum and have no aspect to lose. */
  const FIELDS = ['horizon'];

  it('gives every round graphic fitCenter and every field fitXY', () => {
    const seen = new Set<string>();
    for (const file of readdirSync(LAYOUT).filter((f) => f.startsWith('ridik_'))) {
      const xml = readFileSync(join(LAYOUT, file), 'utf8');
      const at = xml.indexOf('android:id="@+id/ridik_plot"');
      if (at === -1) continue;
      const kind = /^ridik_([a-z]+)_/.exec(file)?.[1];
      if (!kind) continue;
      seen.add(kind);
      expect({
        file,
        scale: /android:scaleType="(\w+)"/.exec(xml.slice(at, xml.indexOf('/>', at)))?.[1],
      }).toEqual({ file, scale: FIELDS.includes(kind) ? 'fitXY' : 'fitCenter' });
    }
    // Every plot face has to have been reached, or this asserted nothing.
    expect([...seen].sort()).toEqual(['horizon', 'route', 'sundial', 'term']);
  });
});
