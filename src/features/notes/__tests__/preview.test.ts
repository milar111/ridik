/**
 * How much of a note is shown without opening it.
 *
 * The cases are real notes this app writes, because the defect was not a bug in
 * a function — it was a constant, `PREVIEW_BULLETS = 2`, that happened to be
 * smaller than almost everything the app produces. A test with a six-bullet
 * fixture would have passed on the old code and told you nothing.
 */
import {
  linesFor,
  previewBullets,
  PREVIEW_CHARS_PER_LINE,
  PREVIEW_LINE_BUDGET,
  PREVIEW_MAX_LINES_PER_BULLET,
} from '../preview';

const bullets = (...contents: string[]) => contents.map((content) => ({ content }));

describe('estimating how tall a bullet is', () => {
  it('counts a short line as one', () => {
    expect(linesFor('Bike Room: 0451')).toBe(1);
  });

  /*
    Measured rather than assumed: the shipped font file puts this sentence at
    579.5pt in the shipped face at `caption`'s 13pt, against a 370pt row. If
    somebody retunes `PREVIEW_CHARS_PER_LINE` and this starts reading as one
    line, the row will draw two and overrun its budget by a line per bullet.
  */
  it('counts the line-practice quote as two', () => {
    const quote =
      'What lies behind us and what lies before us are tiny matters compared to what lies within us.';
    expect(quote.length).toBeGreaterThan(PREVIEW_CHARS_PER_LINE);
    expect(linesFor(quote)).toBe(2);
  });

  /* A pasted paragraph must not be allowed to claim the whole budget and hide
     the four bullets under it. The row caps at two lines, so the estimate does. */
  it('never lets one bullet claim more than the row will draw', () => {
    expect(linesFor('word '.repeat(400))).toBe(PREVIEW_MAX_LINES_PER_BULLET);
  });

  it('counts an empty bullet as one line rather than none', () => {
    expect(linesFor('   ')).toBe(1);
  });
});

describe('what a row shows', () => {
  /* The three notes that made this worth changing. Every one of them fitted on
     the screen it was already on and had to be opened anyway. */
  it.each([
    ['Door Codes', bullets('Bike Room: 0451', 'Studio: 6864', 'Apartment: 0101')],
    ['Reminders', bullets('get flowers', 'pick up pamphlets', 'finish essay')],
    [
      'Daily Log',
      bullets("Narrowed down to a new place in Bed Stuy, Annie's down to move in together."),
    ],
  ])('shows %s in full, holding nothing back', (_name, rows) => {
    const preview = previewBullets(rows);
    expect(preview.shown).toHaveLength(rows.length);
    expect(preview.hidden).toBe(0);
  });

  it('cuts a long note at the budget and counts the rest', () => {
    const rows = bullets(...Array.from({ length: 12 }, (_, i) => `item ${i}`));
    const preview = previewBullets(rows);
    expect(preview.shown).toHaveLength(PREVIEW_LINE_BUDGET);
    expect(preview.hidden).toBe(12 - PREVIEW_LINE_BUDGET);
  });

  it('spends the budget in lines, not in bullets', () => {
    const long = 'x'.repeat(PREVIEW_CHARS_PER_LINE + 10); // two lines each
    const preview = previewBullets(bullets(long, long, long, long, long));
    expect(preview.shown).toHaveLength(PREVIEW_LINE_BUDGET / PREVIEW_MAX_LINES_PER_BULLET);
    expect(preview.hidden).toBe(2);
  });

  /*
    A note whose single bullet is longer than the whole budget still shows it.
    A title over nothing reads as an empty note, which is a different and wrong
    thing to say about one that has a paragraph in it.
  */
  it('always shows the first bullet, whatever it costs', () => {
    const preview = previewBullets(bullets('word '.repeat(500)), 1);
    expect(preview.shown).toHaveLength(1);
    expect(preview.hidden).toBe(0);
  });

  it('says nothing about an empty note', () => {
    expect(previewBullets([])).toEqual({ shown: [], hidden: 0 });
  });
});
