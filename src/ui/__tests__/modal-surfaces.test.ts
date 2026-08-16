/**
 * Every `Modal` in the app is a moving card over a crossfading scrim.
 *
 * Three sheets shipped without it — the confirm dialog, the month picker and
 * the voice sheet all arrived on the platform's scrim fade alone, flat. None of
 * them looked broken, which is exactly the problem: a surface with no entrance
 * is indistinguishable from a screenshot of the app, and nothing fails when a
 * fourth one is written the same way. `sheets.test.tsx` asserts that the two
 * cards move; this asserts that every `Modal` uses one.
 *
 * The `animationType` half is a regression guard on a fixed bug rather than a
 * style rule. `slide` moves the modal's *entire* content, backdrop included, so
 * the scrim travelled up the screen with the card and left a hard horizontal
 * edge across an undimmed page — see `SheetCard` for the full story. The fix is
 * `fade` on the `Modal` plus a transform on the card, and it is one careless
 * `animationType="slide"` away from coming back.
 *
 * Reading the source is crude and it is the only kind of test available for
 * "nobody wrote the next one the old way" — same technique, and same reason, as
 * `src/services/billing/__tests__/boundary.test.ts`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');

/** Every screen and component in the app, as `[path, source]`. */
function sources(): [string, string][] {
  const found: [string, string][] = [];
  const skip = new Set(['node_modules', 'android', 'ios', 'dist', '.git', '__tests__']);

  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(rel);
        continue;
      }
      if (!entry.name.endsWith('.tsx')) continue;
      found.push([rel, readFileSync(join(ROOT, rel), 'utf8')]);
    }
  };

  walk('src');
  walk('app');
  return found;
}

const count = (source: string, needle: string) => source.split(needle).length - 1;

/**
 * Files that actually render one. `<Modal` rather than the word: `SheetCard`'s
 * docblock quotes `Modal animationType="slide"` while explaining why nothing
 * may use it, and a test that failed on its own explanation would be read as
 * noise and deleted.
 */
const modalFiles = sources().filter(([, source]) => source.includes('<Modal'));

describe('every Modal is a card over a crossfade', () => {
  it('finds the sheets to check (a walk that finds nothing would pass vacuously)', () => {
    expect(modalFiles.length).toBeGreaterThanOrEqual(14);
  });

  it.each(modalFiles.map(([file]) => file))('%s draws a SheetCard or a DialogCard', (file) => {
    const source = modalFiles.find(([path]) => path === file)![1];
    // A sheet has an edge to come from and rises; a dialog has none and grows.
    // Which of the two is a design decision, but it has to be one of them.
    expect(source.includes('<SheetCard') || source.includes('<DialogCard')).toBe(true);
  });

  it.each(modalFiles.map(([file]) => file))('%s fades every Modal it opens', (file) => {
    const source = modalFiles.find(([path]) => path === file)![1];
    // Counted rather than merely present: `app/activity.tsx` opens two, and a
    // second one added without the prop would hide behind the first one's.
    expect(count(source, 'animationType="fade"')).toBe(count(source, '<Modal'));
  });

  it.each(modalFiles.map(([file]) => file))('%s takes its spring from the vocabulary', (file) => {
    const source = modalFiles.find(([path]) => path === file)![1];
    // The whole point of `src/ui/motion.ts` is that a sheet cannot be tuned
    // locally into moving unlike every other sheet — and a spring written by
    // hand is also a spring with no `reduceMotion` on it.
    expect(source).not.toMatch(/\b(damping|stiffness)\s*:/);
  });
});
