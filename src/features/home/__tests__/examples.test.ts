/**
 * The cold-start examples, as arithmetic.
 *
 * Two properties carry the whole idea and neither is visible from the
 * component: that a question is always on the screen — the only thing in the
 * app that says `search` exists — and that the user's own names are used when
 * there are any, because a generic example is a brochure and their own list
 * name is a demonstration.
 */
import { buildExamples, exampleWindow, EXAMPLE_COUNT } from '../examples';

const isQuestion = (line: string): boolean => line.endsWith('?');

describe('the example pool', () => {
  it('works with nothing at all to draw on', () => {
    const pool = buildExamples({ lists: [], habits: [] });
    expect(pool.length).toBeGreaterThanOrEqual(EXAMPLE_COUNT);
  });

  it('uses their list and their habit before ours', () => {
    const pool = buildExamples({ lists: ['Hardware'], habits: ['Gym'] });

    expect(pool).toContain('What’s on my Hardware list?');
    expect(pool).toContain('Log Gym');
    // At the front, where a window is guaranteed to reach them.
    expect(pool.slice(0, 2)).toEqual(['Log Gym', 'What’s on my Hardware list?']);
  });

  it('alternates a statement and a question, always', () => {
    for (const sources of [
      { lists: [], habits: [] },
      { lists: ['Hardware'], habits: [] },
      { lists: [], habits: ['Gym', 'Reading', 'Piano'] },
      { lists: ['Hardware', 'Groceries', 'Japan'], habits: ['Gym', 'Reading'] },
    ]) {
      const pool = buildExamples(sources);
      expect(pool.length % 2).toBe(0);
      pool.forEach((line, i) => expect(isQuestion(line)).toBe(i % 2 === 1));
    }
  });

  it('never repeats a line inside the ring', () => {
    const pool = buildExamples({ lists: ['Hardware', 'Groceries'], habits: ['Gym', 'Reading'] });
    expect(new Set(pool).size).toBe(pool.length);
  });

  /* A name long enough to wrap would push the mic's own caption around, and
     these lines are one line each. */
  it('cuts a name that would run off the screen', () => {
    const pool = buildExamples({ lists: ['Everything I might ever need to buy'], habits: [] });
    const line = pool.find(isQuestion)!;
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(46);
  });

  it('ignores blanks and the same list twice', () => {
    const pool = buildExamples({ lists: ['Hardware', 'hardware', '   '], habits: [] });
    expect(pool.filter((line) => line.toLowerCase().includes('hardware'))).toHaveLength(1);
  });
});

describe('the rotation', () => {
  const POOLS = [
    buildExamples({ lists: [], habits: [] }),
    buildExamples({ lists: ['Hardware', 'Groceries'], habits: ['Gym', 'Reading'] }),
  ];

  it('always has one of each on the screen', () => {
    for (const pool of POOLS) {
      for (let tick = 0; tick < pool.length * 2; tick += 1) {
        const shown = exampleWindow(pool, tick);
        expect(shown).toHaveLength(EXAMPLE_COUNT);
        expect(shown.some(isQuestion)).toBe(true);
        expect(shown.some((line) => !isQuestion(line))).toBe(true);
      }
    }
  });

  /* A rotation where two of the three lines stay put reads as a redraw glitch
     rather than as new information. */
  it('replaces the whole set rather than sliding it along', () => {
    const pool = POOLS[1]!;
    const first = exampleWindow(pool, 0);
    const second = exampleWindow(pool, 1);

    expect(second).toHaveLength(EXAMPLE_COUNT);
    expect(second.some((line) => first.includes(line))).toBe(false);
  });

  it('comes back round rather than running out', () => {
    const pool = POOLS[0]!;
    expect(exampleWindow(pool, 99)).toHaveLength(EXAMPLE_COUNT);
    expect(exampleWindow(pool, 0)).toEqual(exampleWindow(pool, pool.length));
  });

  it('has nothing to show for an empty pool', () => {
    expect(exampleWindow([], 3)).toEqual([]);
  });
});
