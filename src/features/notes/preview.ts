/**
 * How much of a note is shown without opening it.
 *
 * The row used to show a flat **two bullets**, whatever the note was, and that
 * number is what made the Notes screen a directory rather than something you
 * can read. Almost every note this app produces is shorter than the preview
 * that hid it:
 *
 *   Door Codes        three lines — showed two and "+1 more"
 *   Line Practice     one sentence — showed one elided line
 *   Daily Log         one sentence — showed one elided line
 *
 * Every one of those had to be opened to read a thing that would have fitted
 * on the screen it was already on. "+1 more" is the worst of it: it spends a
 * whole line saying there is one line you are not being shown.
 *
 * So the budget is **lines, not bullets**. A short note is shown completely and
 * a long one is cut at a place worth cutting, and "+N more" appears only when
 * something is genuinely being held back.
 *
 * ## The numbers
 *
 * `CHARS_PER_LINE` is measured, not guessed. Measured against the font file,
 * the shipped face (Bricolage Grotesque) puts "What lies behind us and what lies
 * before us are tiny matters compared to what lies within us." — 92 characters
 * — at **579.5pt** at `caption`'s 13pt, so 6.30pt a character. A note row spans
 * the gutter to the gutter: 402 − 32 = 370pt on an iPhone 17 Pro, which is
 * **58.7** characters. Rounded down, because over-estimating the width is what
 * makes a two-line bullet get counted as one and pushes the row past its
 * budget.
 *
 * It is an estimate and has to be: React Native measures text natively and
 * asynchronously, and a preview that waited for a real measurement would
 * reflow the list under the reader's thumb. An estimate that is occasionally a
 * line out costs a slightly taller or shorter row; measuring properly costs the
 * list jumping. The error is also bounded in the direction that matters —
 * `MAX_LINES_PER_BULLET` caps what one long bullet can claim, so a paragraph
 * pasted into a note cannot eat the whole budget and hide the four bullets
 * under it.
 */

/** Total lines of bullet text a row will draw before it starts counting. */
export const PREVIEW_LINE_BUDGET = 6;

/** Measured at `caption` (13pt Bricolage) across a full-width note row. */
export const PREVIEW_CHARS_PER_LINE = 58;

/** No single bullet may take the whole budget. Matches `numberOfLines` on it. */
export const PREVIEW_MAX_LINES_PER_BULLET = 2;

/** What `☐ ` / `• ` costs at the head of every bullet. */
const MARKER_CHARS = 2;

export type PreviewBullet = { content: string };

/** How many lines this bullet will take, capped at what the row will draw. */
export function linesFor(content: string): number {
  const width = content.trim().length + MARKER_CHARS;
  const lines = Math.max(1, Math.ceil(width / PREVIEW_CHARS_PER_LINE));
  return Math.min(lines, PREVIEW_MAX_LINES_PER_BULLET);
}

export type Preview<T> = {
  shown: T[];
  /** Bullets not on screen. Zero means the note is shown in full. */
  hidden: number;
};

/**
 * The bullets a row draws, and how many it is holding back.
 *
 * The first bullet is always shown even when it alone blows the budget: a row
 * with a title and no content at all reads as an empty note, which is a
 * different and wrong thing to say about a note that has one long paragraph in
 * it.
 */
export function previewBullets<T extends PreviewBullet>(
  bullets: readonly T[],
  budget = PREVIEW_LINE_BUDGET,
): Preview<T> {
  const shown: T[] = [];
  let used = 0;

  for (const bullet of bullets) {
    const cost = linesFor(bullet.content);
    if (shown.length > 0 && used + cost > budget) break;
    shown.push(bullet);
    used += cost;
  }

  return { shown, hidden: bullets.length - shown.length };
}
