/**
 * The examples are promises, so they have to be true.
 *
 * This list is the first thing a new user reads and the thing they come back to
 * when they want to do something new. A line the assistant cannot honour is not
 * one unsupported phrase — it teaches the user that the app is unreliable, and
 * they stop trying the ones that *do* work.
 *
 * So every entry names the tool it exercises and this checks the name against
 * the contract. Renaming or removing a tool fails here rather than silently
 * turning a reference screen into a list of lies.
 */
import { TOOL_NAMES } from '@/llm/contract';

import { PHRASE_GROUPS, SAFETY_POINTS } from '../phrases';

describe('the phrase catalogue', () => {
  it('only promises tools that exist', () => {
    for (const group of PHRASE_GROUPS) {
      for (const phrase of group.phrases) {
        expect(TOOL_NAMES).toContain(phrase.tool);
      }
    }
  });

  /*
   * `note` was where a *gap* was stated — "you cannot remove a list item yet".
   * Those gaps are closed: `checklist_remove`, `checklist_delete`,
   * `task_update`, `task_delete` and `ledger_delete` exist. What replaced them
   * is the more dangerous problem the new tools created — three domains now
   * carry two verbs that sound identical to somebody who has never read a
   * contract. Ticking an item off keeps it; taking it off does not. Completing
   * a task counts towards the day; deleting it does not. Both pairs are one
   * spoken word apart and only one of each is recoverable.
   *
   * So these three still say something, and it is now a distinction rather
   * than an apology.
   */
  it.each(['lists', 'tasks', 'money'])('spells out the confusable pair in %s', (key) => {
    const group = PHRASE_GROUPS.find((candidate) => candidate.key === key);
    expect(group?.note).toBeTruthy();
  });

  /*
   * The reason somebody speaks a short, careful, low-value sentence instead of
   * a real one is that nobody has told them what happens when it mishears. Each
   * of these names a mechanism that exists — the review composer, the
   * confirmation gate, the undo allow-list, the offline matcher.
   */
  it('says what happens when it gets something wrong', () => {
    expect(SAFETY_POINTS.length).toBeGreaterThanOrEqual(3);
    for (const point of SAFETY_POINTS) expect(point.trim().length).toBeGreaterThan(20);
  });

  /*
   * Said out loud, so it reads as speech rather than as a command: no sentence
   * capital, no full stop. `I` is the one capital a spoken line can open with,
   * and excluding it would force "i can't book the hall" onto the screen.
   */
  it('is written the way somebody talks', () => {
    for (const group of PHRASE_GROUPS) {
      for (const { say } of group.phrases) {
        expect(say).not.toMatch(/^(?!I\b)[A-Z]/);
        expect(say).not.toMatch(/\.$/);
      }
    }
  });

  it('covers every part of the app somebody would look for', () => {
    const keys = PHRASE_GROUPS.map((group) => group.key);
    for (const expected of ['calendar', 'tasks', 'lists', 'money', 'notes', 'habits']) {
      expect(keys).toContain(expected);
    }
  });
});
