/**
 * The degraded engine, which is the one that runs when things have already
 * gone wrong.
 *
 * `fallbackInterpret` is four hand-written patterns, reached when there is no
 * API key, no network, or a spent budget. It has no tests until now, which is
 * backwards: this is the path a user hits on a bad day, and a mistake here is
 * made while they already cannot see what the assistant is doing.
 *
 * Its design rule is that everything unrecognised becomes a note, because a
 * note is lossless even when the classification is wrong. These tests exist to
 * hold that rule — the failure they were written for is the opposite, a pattern
 * confidently producing a *partly* correct row.
 */
import { fallbackInterpret } from '../provider/mock';

/** The single action a turn produced, or null when it declined to guess. */
function actionOf(transcript: string): { tool: string; params: Record<string, unknown> } | null {
  // Already an `LlmResponse`, not a JSON string: this engine builds the object
  // and validates it against the same schema the real provider's reply passes.
  const first = fallbackInterpret(transcript).actions?.[0];
  return first
    ? { tool: first.tool_name, params: first.parameters as Record<string, unknown> }
    : null;
}

describe('a spend and a second sentence', () => {
  /* The bug: `SPENT_RE` ends in `(.+)`, so it ran to the end of the utterance
     and filed the rest of the sentence as the category. One plausible-looking
     receipt, half the sentence gone, nothing said about it. */
  it('does not file the next instruction as the category', () => {
    const action = actionOf('Spent 12 leva on lunch and I ran 5k this morning');

    expect(action?.tool).toBe('ledger_add');
    expect(action?.params.category).toBe('lunch');
    expect(String(action?.params.category)).not.toContain('5k');
  });

  it('stops at an imperative it recognises', () => {
    const action = actionOf('Paid 30 for the filament and add it to the drone project');

    expect(action?.params.category).toBe('the filament');
    expect(String(action?.params.category)).not.toContain('drone');
  });

  /* The other half of the rule, and the reason this is not a plain split on
     "and": a compound category is the commonest shape a spend has. Splitting
     it would invent a boundary the user did not say, which is the worse error
     — a wrong label on the right amount beats half the amount's meaning. */
  it('keeps a compound category whole', () => {
    expect(actionOf('Spent 12 on lunch and drinks')?.params.category).toBe('lunch and drinks');
    expect(actionOf('Paid 8 for coffee and a croissant')?.params.category).toBe(
      'coffee and a croissant',
    );
  });

  it('reads the amount and currency either side of the fix', () => {
    const action = actionOf('Spent 12.50 eur on lunch and I ran 5k');

    expect(action?.params.amount).toBe(12.5);
    expect(action?.params.currency).toBe('EUR');
  });

  /* Whatever the pattern understood, the sentence itself survives. This engine
     gets one pattern per turn, so the run above is genuinely lost as an action
     — but it must not be lost as a record. */
  it('keeps the whole utterance in the description', () => {
    const said = 'Spent 12 leva on lunch and I ran 5k this morning';

    expect(actionOf(said)?.params.description).toContain('5k');
  });
});

describe('the patterns that were already right', () => {
  /* `CHECKLIST_RE` is lazy and anchored on `list\b`, so it was never affected
     by the greedy-tail bug. Asserted so a future tidy-up of the regexes above
     cannot quietly break it. */
  it('takes only the item and the list name', () => {
    const action = actionOf('add milk to the shopping list and remind me to call mum');

    expect(action?.tool).toBe('checklist_add');
    expect(JSON.stringify(action?.params)).toContain('milk');
    expect(JSON.stringify(action?.params)).not.toContain('call mum');
  });

  it('falls back to a note rather than guessing', () => {
    const action = actionOf('the thing about the thing we discussed on tuesday');

    expect(action?.tool).toBe('note_create');
  });
});

/**
 * A question, which arrived here the day home started telling people they may
 * ask one.
 *
 * Every other pattern in this file writes a row, so its rule is that anything
 * unrecognised becomes a note. `search` inverts that: it writes nothing, so a
 * wrong guess costs "I found nothing" — while a question filed as a note is a
 * note nobody will ever read, and the answer is lost either way.
 */
describe('asking rather than telling', () => {
  it('searches for what a question is about', () => {
    const action = actionOf('Where did I write about the lab?');

    expect(action?.tool).toBe('search');
    expect(action?.params.query).toBe('lab');
  });

  /* The grammar has to come out: `scoreText` averages over the query's tokens,
     so six filler words divide the one that matters below the threshold and the
     search runs and finds nothing. */
  it('keeps only the words worth matching', () => {
    expect(actionOf('What’s on my Hardware list?')?.params.query).toBe('Hardware');
    expect(actionOf("What's on my Hardware list?")?.params.query).toBe('Hardware');
    expect(actionOf('What have I got on Friday?')?.params.query).toBe('Friday');
  });

  it('takes an imperative to find as the same thing', () => {
    const action = actionOf('Find everything about the resistors');

    expect(action?.tool).toBe('search');
    expect(action?.params.query).toBe('resistors');
  });

  /**
   * Before the patterns that write, and this is the case that decides the
   * order: `SPENT_RE` matches "have I paid 50 for the parts?" and would book
   * fifty euros in answer to a question about whether it had been booked.
   */
  it('does not book a spend that was being asked about', () => {
    const action = actionOf('Have I paid 50 for the parts?');

    expect(action?.tool).toBe('search');
    expect(action?.tool).not.toBe('ledger_add');
  });

  /* A statement is still a statement. Nothing here may take an order away from
     the pattern that would have carried it out. */
  it('leaves an ordinary instruction alone', () => {
    expect(actionOf('Spent 12 leva on lunch')?.tool).toBe('ledger_add');
    expect(actionOf('add milk to the shopping list')?.tool).toBe('checklist_add');
    expect(actionOf('The wifi password is on the router')?.tool).toBe('note_create');
  });

  /* Nothing left after the grammar is not a question this can answer, so it
     keeps what was said rather than searching for an empty string. */
  it('keeps a question it cannot make a query out of', () => {
    expect(actionOf('What is it?')?.tool).toBe('note_create');
  });
});
