/**
 * Nothing inside a weighted container may have a fixed height.
 *
 * A `RemoteViews` layout is handed a box by whichever launcher is drawing it,
 * and the app has no say in how big that box is. So a face is a chain of
 * weights — the plate area is `weight=3`, the well inside it is `weight=1`, and
 * each of the six week rows is `weight=1` of the well — and every link in that
 * chain shrinks when the box does. A fixed-height leaf at the bottom of it
 * cannot, and Android does not clip it to its parent: it draws it anyway, over
 * whatever comes next.
 *
 * That is exactly what shipped. Each day cell was 25dp inside a row that was
 * one sixth of a flexible well, and the month rendered as three bands of
 * overlapping half-numerals — reported from a real Galaxy S23. It had never
 * appeared in a year of development because the widget picker had only ever
 * been opened on a Pixel, whose picker gives a 4×3 preview a taller box than
 * Samsung's One UI launcher does. Nothing logged, nothing failed, and the tile
 * was simply unreadable on one of the two launchers that matter most.
 *
 * Reads the **generated** XML rather than the plugin source, for the reason
 * `widget-tokens.test.ts` sets out at length: an assertion that reads something
 * other than what ships is not an assertion about what ships. Skips when
 * `android/` has not been generated — a fresh clone or CI — exactly as
 * `widget-target-sync.test.ts` skips without `ios/`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const LAYOUTS = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout');

const ANDROID = 'http://schemas.android.com/apk/res/android';
const present = existsSync(LAYOUTS);

/** `android:foo="bar"` on the element that owns the id, without an XML parser. */
function elementsWithId(xml: string): { id: string; attrs: string }[] {
  const found: { id: string; attrs: string }[] = [];
  // Each element is `<Tag\n  android:a="1"\n  … />` or `…>`; split on `<`.
  for (const chunk of xml.split('<')) {
    const id = /android:id="@\+id\/([A-Za-z0-9_]+)"/.exec(chunk);
    if (id) found.push({ id: id[1]!, attrs: chunk });
  }
  return found;
}

const heightOf = (attrs: string): string | null =>
  /android:layout_height="([^"]+)"/.exec(attrs)?.[1] ?? null;

const files = present ? readdirSync(LAYOUTS).filter((f) => f.startsWith('ridik_')) : [];

(present ? describe : describe.skip)('the generated widget layouts', () => {
  it('has layouts to read, and the namespace they are written against', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(readFileSync(join(LAYOUTS, files[0]!), 'utf8')).toContain(ANDROID);
  });

  /**
   * The specific regression. A day cell fills the week row it is given; the row
   * divides the well; the well divides the plate. No link states a dp.
   */
  it('never gives a calendar day cell a height it cannot give back', () => {
    const offenders: string[] = [];
    let cells = 0;

    for (const file of files.filter((f) => f.startsWith('ridik_cal_'))) {
      const xml = readFileSync(join(LAYOUTS, file), 'utf8');
      for (const el of elementsWithId(xml)) {
        // `ridik_plate_12` is a cell; `ridik_plate_area` and
        // `ridik_plate_week_3` are its weighted containers and are meant to be
        // `0dp`, which is how a weight is spelled.
        if (!/^ridik_plate_\d+$/.test(el.id)) continue;
        cells += 1;
        const height = heightOf(el.attrs);
        if (height !== 'match_parent') offenders.push(`${file} ${el.id} → ${height}`);
      }
    }

    expect(cells).toBeGreaterThan(300);
    expect(offenders).toEqual([]);
  });

  /**
   * The same bug in text rather than in layout.
   *
   * A habit name given two lines does not ellipsise when it does not fit — it
   * breaks the word. "Water" rendered as "Wate r" and "Vitamin" as "Vita min"
   * on the same S23, because Samsung's system font is wider than Roboto and the
   * column is sized in dp. One line and an ellipsis degrades honestly; a
   * mid-word break just looks broken.
   */
  it('never lets a habit name break mid-word', () => {
    const offenders: string[] = [];

    for (const file of files.filter((f) => f.startsWith('ridik_rings_'))) {
      const xml = readFileSync(join(LAYOUTS, file), 'utf8');
      for (const el of elementsWithId(xml)) {
        if (!/^ridik_ring_name_\d+$/.test(el.id)) continue;
        const maxLines = /android:maxLines="(\d+)"/.exec(el.attrs)?.[1];
        const ellipsize = /android:ellipsize="([^"]+)"/.exec(el.attrs)?.[1];
        if (maxLines !== '1' || ellipsize !== 'end') {
          offenders.push(`${file} ${el.id} → maxLines=${maxLines} ellipsize=${ellipsize}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
