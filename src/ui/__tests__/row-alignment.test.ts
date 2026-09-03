/**
 * One left edge per screen.
 *
 * A row sized its own leading slot from whatever was in it — 19dp for a glyph,
 * 42 for the ember swatch, nothing at all without an icon — which is invisible
 * inside a card, because a card tends to be all one kind, and obvious down a
 * screen. Settings put `Free`, `Microphone` and `Where your words go` at 61dp,
 * `Speak replies` at 30 and `Ember` at 80: three left edges in one list.
 *
 * `ROW_LEAD` is that column and `ReserveRowLead` is what turns it on. It is
 * deliberately **not** always-on — 314 of the app's 711 rows have no icon and
 * live on screens that have none anywhere, where a reserved column is an indent
 * that means nothing. So it is opt-in per screen, which makes it exactly the
 * kind of thing that gets forgotten on the next screen someone adds.
 *
 * Hence reading the source: the two screens that mix the two kinds of row have
 * to declare it, and the swatch has to be drawn to the column rather than the
 * column widened to the swatch.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

const ROWS = read('src', 'features', 'settings', 'Rows.tsx');
const SCREEN = read('src', 'ui', 'components', 'Screen.tsx');

describe('the settings leading column', () => {
  it('is one number, and the row slot is drawn to it', () => {
    expect(/export const ROW_LEAD = (\d+)/.exec(ROWS)?.[1]).toBe('22');
    // The slot is a fixed width, not the icon's own — otherwise a row with no
    // icon collapses it and the label jumps left.
    expect(ROWS).toMatch(/lead: \{ width: ROW_LEAD/);
  });

  it('reserves the column for a row with no icon when the screen asks', () => {
    // `icon || reserve` is the whole rule: draw the slot when there is
    // something to put in it, or when the screen said every row keeps one.
    expect(ROWS).toMatch(/\{icon \|\| reserve \?/);
  });

  /**
   * Both screens carry cards with icons and cards without. A third screen that
   * starts mixing them has to opt in too, and will fail here until it does.
   */
  it.each([
    ['app/settings.tsx'],
    ['app/developer.tsx'],
  ])('%s reserves the column across all its cards', (file) => {
    const source = read(...file.split('/'));
    expect(source).toMatch(/<ReserveRowLead>/);
    expect(source).toMatch(/<\/ReserveRowLead>/);
  });

  it('indents what is in a card but is not a row by the same column', () => {
    // A card is rarely all rows. Developer's Assistant card interleaves them
    // with a chip block and two sliders, and only the rows knew about the
    // column: labels at 64pt, everything between them at 29.
    expect(ROWS).toMatch(/export function useRowLeadInset\(\): number/);
    expect(ROWS).toMatch(/ROW_LEAD \+ spacing\.md/);
    // Every block in that card measures from the same inset.
    expect(ROWS.match(/paddingLeft: spacing\.md \+ lead/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(read('app', 'developer.tsx')).toMatch(/paddingLeft: spacing\.md \+ lead/);
  });

  it('draws the ember swatch to the column instead of widening it', () => {
    const settings = read('app', 'settings.tsx');
    // Four cells of 4 with 2dp between them is 22 — the column exactly. The
    // old swatch was 9dp cells, 42dp wide, and pushed one row's label out on
    // its own.
    expect(settings).toMatch(/width: ROW_LEAD, flexDirection: 'row', gap: 2/);
    expect(settings).toMatch(/width: 4, height: 22/);
  });
});

/**
 * The other left edge, one level up: the screen's own title.
 *
 * A 26pt chevron in the same flex row as the heading pushed it to 47pt while
 * every card, section label and list row beneath it sat on the 16pt gutter —
 * and `Menu`, which has no chevron, kept its title at 16. Two left edges on one
 * screen and a third between screens. The controls have their own row now, so
 * the title starts where the body starts on all of them.
 */
/**
 * The cross axis is not the axis you think it is.
 *
 * `Button` sets `alignSelf: 'flex-start'` so that a button stacked in a column
 * hugs its label instead of stretching to the full width. In a **row** that
 * same declaration addresses the *vertical* axis and means "hug the top", and
 * `alignSelf` on a child beats `alignItems` on its parent — so a row that says
 * `alignItems: 'center'` gets a centred icon and a top-pinned button, which is
 * exactly what Profile shipped: `Change` level with the title of a six-line row
 * with a hand's width of empty card beneath it.
 *
 * There is no direction-agnostic way to say "do not stretch" in flexbox, so
 * `Button` cannot fix this for itself — only the caller knows which axis it is
 * on. These are the places that have had to say so.
 */
describe('a Button on a row', () => {
  it('is centred by the slot it sits in, on every settings row', () => {
    // Wrapping restores a column context: inside it the Button's own
    // `alignSelf` means the horizontal thing it was written to mean, and the
    // row's `alignItems` gets to decide the vertical.
    expect(ROWS).toMatch(/\{right \? <View style=\{styles\.rowRight\}>\{right\}<\/View> : null\}/);
    expect(ROWS).toMatch(/rowRight: \{ alignItems: 'flex-end' \}/);
  });

  /** Message-and-retry rows: the message is allowed to wrap, so this shows. */
  it.each([
    ['src/features/calendar/AgendaList.tsx'],
    ['src/features/notes/Placeholders.tsx'],
    ['app/curriculum.tsx'],
  ])('%s centres its retry rather than letting it ride the first line', (file) => {
    const source = read(...file.split('/'));
    expect(source).toMatch(/centreOnRow: \{ alignSelf: 'center' \}/);
    expect(source).toMatch(/style=\{styles\.centreOnRow\}/);
  });

  it('src/features/today/Fallbacks.tsx does the same on its own retry style', () => {
    expect(read('src', 'features', 'today', 'Fallbacks.tsx')).toMatch(
      /retry: \{ alignSelf: 'center'/,
    );
  });
});

describe('the screen header', () => {
  it('puts the controls on a row of their own, above the title', () => {
    const controls = SCREEN.indexOf('<View style={[styles.controls');
    const heading = SCREEN.indexOf('<View style={styles.headerText}>');
    expect(controls).toBeGreaterThan(-1);
    expect(heading).toBeGreaterThan(controls);
    // Siblings under one padded wrapper, not children of one flex row: a
    // `flexDirection: 'row'` on the thing that holds both is the regression.
    expect(SCREEN).toMatch(/controls: \{ flexDirection: 'row'/);
    expect(SCREEN).not.toMatch(/header: \{\s*flexDirection: 'row'/);
  });

  it('is the only bare back chevron in the app', () => {
    // Three screens hand-rolled their own: 24pt glyphs with 8pt and 12pt hit
    // slops beside this one's 26 and 10, and `app/note/[id]` called
    // `router.back()` with no answer for the empty stack a widget or a
    // notification opens it with. A `Button icon="chevron-back"` is a
    // different affordance and is left alone; a bare `Ionicons` is this.
    const offenders = readdirSync(join(ROOT, 'app'), { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.tsx'))
      .filter((name) => /<Ionicons\s+name="chevron-back"/.test(read('app', name)));
    expect(offenders).toEqual([]);
  });

  it('never drops a way out for want of a title', () => {
    // `app/calendar.tsx` passed `back` and got nothing, because the header
    // hung off `title || right`. It draws its own month row and puts the
    // shared control in it instead.
    expect(SCREEN).toMatch(/const controls = back \|\| right \|\| close;/);
    expect(SCREEN).toMatch(/title \|\| controls \? \(/);
    expect(SCREEN).toMatch(/export function BackControl\(\{/);
    expect(read('app', 'calendar.tsx')).toMatch(/<BackControl \/>/);
  });
});
