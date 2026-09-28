/**
 * The last few things you said, handed back to the model on the next turn.
 *
 * Until this existed every utterance was a first utterance. `historyFor` in
 * the orchestrator built history only for a *pending clarification* — the
 * model's own question and the sentence that provoked it — so two sentences
 * spoken twenty seconds apart were two unrelated conversations, and the second
 * one arrived with no subject.
 *
 * That is the whole reason free speech did not work here. Nobody talks in
 * self-contained commands:
 *
 *   "Add flowers to my list."   "Toilet paper."
 *
 * The second utterance names no list, no verb and no destination. It is only
 * meaningful as a continuation, and with nothing carried over it became a note
 * saying "Toilet paper" — filed somewhere the user never looked again. The
 * whole point of speaking rather than typing is that you do not have to
 * restate what you just said.
 *
 * ## Why messages and not a prompt block
 *
 * These ride as `history` on the request, *outside* the system prompt, and
 * that is deliberate. The system prompt is the cached prefix — `prompt-cache.test.ts`
 * measures it — and it is identical from turn to turn precisely so a provider
 * can charge less for it. Recent turns change on every single utterance, so
 * putting them in there would bust the cache on every call and pay for the
 * whole 7 kB contract again to carry forty words.
 *
 * ## The window is a conversation, not a lifetime
 *
 * Two bounds, and both matter for different reasons. `RECALL_TURNS` is what
 * the model can hold usefully; `RECALL_WINDOW_MS` is what a *person* would
 * still consider the same conversation. Without the second, a bare "yes" on
 * Tuesday morning is read as an answer to something said on Sunday night — the
 * failure is silent, and it writes a row.
 *
 * ## What is safe to replay
 *
 * A past transcript is still an utterance, so RULE 15 covers it: it is data,
 * never instructions, and the model is told so about the current one in terms
 * that do not stop applying to the previous one. The `model` lines are this
 * app's own composition — the sentence the model spoke plus the audited list
 * of what the executor actually did — rather than raw model output replayed
 * verbatim. A turn is summarised by what *happened*, not by what was proposed,
 * because the second is what the model already believes and the first is the
 * only thing that can correct it.
 */
import type { LlmMessage } from '@/llm/provider';
import type { Interaction, InteractionAction } from '@/repositories/llmInteractions';

/**
 * How many recent turns travel. Six is two or three exchanges — enough for
 * "add flowers … toilet paper … and batteries", which is the shape this is
 * for, and short enough that it never crowds out the contract.
 */
export const RECALL_TURNS = 6;

/**
 * How long a turn stays part of "this conversation".
 *
 * Ten minutes. Long enough to put the phone down mid-thought and pick it back
 * up, short enough that the next time you speak is a fresh start — which is
 * what a person means by it, and what stops a bare fragment being read against
 * something said last night.
 */
export const RECALL_WINDOW_MS = 10 * 60_000;

/** Keeps one replayed line from carrying a paragraph into every later turn. */
const LINE_CAP = 240;

/** How many of a turn's actions are named. A long batch is summarised, not listed. */
const ACTIONS_PER_TURN = 4;

function clamp(text: string, cap: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= cap ? trimmed : `${trimmed.slice(0, cap - 1)}…`;
}

/**
 * One action, as the thing it did rather than the thing it was asked to do.
 *
 * The executor's own `summary` is preferred because it names the row that was
 * actually written — "Added flowers to Shopping", where the parameters only
 * said `list: "my list"`. That difference is exactly what a continuation needs:
 * the next fragment has to land on *Shopping*, and the model has no other way
 * to learn that name.
 */
function describeAction(action: InteractionAction): string | null {
  if (action.asked) return `asked: ${clamp(action.asked, 80)}`;
  if (!action.ok) return null;
  const summary = action.summary ? clamp(action.summary, 80) : null;
  return summary ? `${action.toolName} — ${summary}` : action.toolName;
}

/**
 * What the app did with one turn, in one line.
 *
 * The spoken sentence alone is not enough. "Three things noted" tells the model
 * nothing about *which* list was written, and a continuation needs the name.
 * So the sentence carries the tone and the bracket carries the facts.
 */
export function describeTurn(row: Interaction): string {
  const spoken = row.feedback ? clamp(row.feedback, LINE_CAP) : null;
  const did = row.parsedActions
    .map(describeAction)
    .filter((line): line is string => line !== null);

  const shown = did.slice(0, ACTIONS_PER_TURN);
  const overflow = did.length - shown.length;
  if (overflow > 0) shown.push(`and ${overflow} more`);

  const facts = shown.length > 0 ? `[${shown.join('; ')}]` : null;

  // An error is stated rather than dropped: "try that again" is a real thing
  // to say next, and it needs to know what failed.
  const failed = row.status === 'error' ? '[nothing was written]' : null;

  return [spoken, facts ?? failed].filter((part) => part !== null).join(' ') || 'Okay.';
}

export type RecallOptions = {
  /** The clock for the window. Always `now()` from the caller, never `Date.now()`. */
  now: number;
  turns?: number;
  windowMs?: number;
};

/**
 * Recent turns as alternating messages, oldest first.
 *
 * Rows arrive newest-first from `listRecent`, which is the order that table is
 * indexed for; a conversation reads the other way, so they are reversed here
 * rather than at the call site.
 *
 * Never throws and never guesses: a row with an empty transcript contributes
 * nothing, because a `user` message with no content is a turn the model has to
 * account for and cannot.
 */
export function recallMessages(
  rows: readonly Interaction[],
  { now, turns = RECALL_TURNS, windowMs = RECALL_WINDOW_MS }: RecallOptions,
): LlmMessage[] {
  const floor = now - windowMs;
  /*
   * Only a floor, and deliberately no ceiling.
   *
   * The obvious guard here is `row.createdAt < now`, to stop the turn being
   * spoken appearing in its own history — and it is guarding nothing, because
   * `audit()` writes at the *end* of a turn, so the row does not exist yet when
   * this runs. What it does instead is break under a frozen clock: every test
   * in this repo freezes time, so two turns share a millisecond, and the guard
   * silently dropped the whole window. A module that only works while the clock
   * is moving is one whose bugs cannot be reproduced, which is the exact thing
   * `now()` exists to prevent.
   */
  const recent = rows
    .filter((row) => row.createdAt >= floor)
    .slice(0, Math.max(0, turns));

  const messages: LlmMessage[] = [];
  for (const row of [...recent].reverse()) {
    const said = clamp(row.transcript, LINE_CAP);
    if (said === '') continue;
    messages.push({ role: 'user', content: said });
    messages.push({ role: 'model', content: describeTurn(row) });
  }
  return messages;
}
