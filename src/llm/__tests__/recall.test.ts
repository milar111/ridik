/**
 * The conversation, handed back to the model.
 *
 * Every assertion here is a sentence somebody would actually say second. That
 * is the point of the module and the reason it is tested on its own rather
 * than through the orchestrator: the failure it exists to stop is silent — a
 * fragment lands *somewhere*, a row gets written, a receipt says "Noted", and
 * only weeks later does anybody find the shopping split across two lists.
 */
import { describeTurn, recallMessages, RECALL_TURNS, RECALL_WINDOW_MS } from '@/llm/recall';
import type { Interaction, InteractionAction } from '@/repositories/llmInteractions';

const NOW = 1_772_000_000_000;

function action(over: Partial<InteractionAction> = {}): InteractionAction {
  return {
    toolName: 'checklist_add',
    parameters: { list_name: 'my list', items: ['flowers'] },
    ok: true,
    summary: 'Added flowers to Shopping',
    error: null,
    asked: null,
    ...over,
  };
}

function turn(over: Partial<Interaction> = {}): Interaction {
  return {
    id: 'i1',
    transcript: 'Add flowers to my list.',
    confidence: 0.95,
    rawResponse: null,
    actions: null,
    feedback: 'Added flowers to the shopping list.',
    status: 'ok',
    error: null,
    latencyMs: 900,
    model: 'gemini-3.1-flash-lite',
    createdAt: NOW - 20_000,
    parsedActions: [action()],
    ...over,
  } as Interaction;
}

describe('what one past turn says', () => {
  /*
    The single most important line in the module. The user said "my list"; the
    executor wrote "Shopping". A continuation has to land on *Shopping*, and
    the model's only way to learn that name is the executor's own summary —
    the parameters still say "my list" and would send the next fragment to a
    second, near-duplicate list.
  */
  it('names the row that was written, not the words that were said', () => {
    const line = describeTurn(turn());
    expect(line).toContain('Shopping');
    expect(line).not.toContain('my list');
  });

  it('keeps the spoken sentence as well, because it carries the tone', () => {
    expect(describeTurn(turn())).toContain('Added flowers to the shopping list.');
  });

  it('says a failed turn wrote nothing, so "try that again" has a subject', () => {
    const line = describeTurn(
      turn({ status: 'error', feedback: 'The assistant could not be reached.', parsedActions: [] }),
    );
    expect(line).toContain('nothing was written');
  });

  it('carries a question it asked rather than reporting it as work done', () => {
    const line = describeTurn(
      turn({
        status: 'clarify',
        feedback: 'I need a time first.',
        parsedActions: [action({ ok: false, summary: null, asked: 'Book it tomorrow at 10:00?' })],
      }),
    );
    expect(line).toContain('asked: Book it tomorrow at 10:00?');
  });

  /* A failed action is not a row anybody can continue from, and listing it as
     though it were is worse than silence: the next fragment attaches to it. */
  it('leaves out an action that did not apply', () => {
    const line = describeTurn(
      turn({ parsedActions: [action({ ok: false, summary: 'Added flowers to Shopping' })] }),
    );
    expect(line).not.toContain('Shopping');
  });

  it('summarises a long batch instead of listing all of it', () => {
    const line = describeTurn(
      turn({
        parsedActions: Array.from({ length: 7 }, (_, i) =>
          action({ summary: `Wrote row ${i}` }),
        ),
      }),
    );
    expect(line).toContain('and 3 more');
    expect(line).not.toContain('Wrote row 6');
  });

  it('never comes back empty', () => {
    expect(describeTurn(turn({ feedback: null, parsedActions: [] }))).toBe('Okay.');
  });
});

describe('the window', () => {
  it('reads oldest first, the way a conversation does', () => {
    const rows = [
      turn({ id: 'b', transcript: 'Toilet paper.', createdAt: NOW - 5_000 }),
      turn({ id: 'a', transcript: 'Add flowers to my list.', createdAt: NOW - 20_000 }),
    ];
    const messages = recallMessages(rows, { now: NOW });
    expect(messages.map((m) => m.role)).toEqual(['user', 'model', 'user', 'model']);
    expect(messages[0]!.content).toBe('Add flowers to my list.');
    expect(messages[2]!.content).toBe('Toilet paper.');
  });

  /*
    Ten minutes, and the reason is not cost. A bare "yes" spoken on Tuesday
    morning read against a question from Sunday night writes a row nobody asked
    for, and nothing on screen says why.
  */
  it('drops anything older than the window', () => {
    const rows = [
      turn({ id: 'old', transcript: 'Book the dentist.', createdAt: NOW - RECALL_WINDOW_MS - 1 }),
      turn({ id: 'new', transcript: 'Toilet paper.', createdAt: NOW - 1_000 }),
    ];
    const said = recallMessages(rows, { now: NOW })
      .filter((m) => m.role === 'user')
      .map((m) => m.content);
    expect(said).toEqual(['Toilet paper.']);
  });

  it('carries at most RECALL_TURNS of them', () => {
    const rows = Array.from({ length: RECALL_TURNS + 4 }, (_, i) =>
      turn({ id: `t${i}`, transcript: `Utterance ${i}.`, createdAt: NOW - i * 1_000 }),
    );
    expect(recallMessages(rows, { now: NOW })).toHaveLength(RECALL_TURNS * 2);
  });

  /*
    This started life as the opposite assertion — that a row stamped exactly
    `now` was dropped, on the reasoning that it must be the turn being spoken.
    It cannot be: `audit()` writes at the end of a turn, so the row does not
    exist yet when the window is read. What the guard actually did was throw
    away the entire history under a frozen clock, which is what every test in
    this repo runs under and what `now()` exists to make possible. It is kept
    as a test because the reasoning is tempting enough to be reintroduced.
  */
  it('keeps a turn stamped in the same millisecond, because tests freeze the clock', () => {
    const rows = [turn({ id: 'tie', transcript: 'Toilet paper.', createdAt: NOW })];
    expect(recallMessages(rows, { now: NOW }).map((m) => m.content)).toContain('Toilet paper.');
  });

  it('skips a row with no transcript rather than sending an empty user message', () => {
    const rows = [turn({ id: 'blank', transcript: '   ', createdAt: NOW - 1_000 })];
    expect(recallMessages(rows, { now: NOW })).toEqual([]);
  });

  it('clamps a long dictation so one turn cannot fill the window', () => {
    const rows = [turn({ transcript: 'word '.repeat(400), createdAt: NOW - 1_000 })];
    const [first] = recallMessages(rows, { now: NOW });
    expect(first!.content.length).toBeLessThanOrEqual(240);
    expect(first!.content.endsWith('…')).toBe(true);
  });
});
