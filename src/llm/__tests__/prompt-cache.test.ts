/**
 * What prompt caching could and could not do for this prompt, kept as
 * arithmetic rather than as a paragraph somebody will disagree with in six
 * months.
 *
 * Every provider that discounts a cached prompt discounts a *prefix*: the bytes
 * from the start of the request up to the first one that differs from a request
 * it has seen before. So two numbers decide whether caching is worth anything,
 * and both are measured here:
 *
 *   1. how long the byte-identical prefix of two consecutive turns actually is
 *      (today: the identity header, and nothing else, because NOW and CONTEXT
 *      sit in front of all the static prose);
 *   2. how long it *could* be if the prompt were reordered so every static
 *      block came first.
 *
 * **This file does not conclude that reordering is pointless, and an earlier
 * version did.** That conclusion rested on `MIN_CACHEABLE_PREFIX_TOKENS =
 * 4_096` — a vendor number nothing in this repo can verify, against a measured
 * ~2,700 with a margin of 1.5x, for a model named by the moving alias
 * `gemini-flash-latest` whose minimum can change without a line of code
 * changing here. The family has shipped 1,024 (2.5 Flash), 2,048 (2.5 Pro) and
 * 4,096 (3.x) at various points, so the honest reading is that the reorder is
 * *plausibly* worth ~30% of the input side and *plausibly* worth nothing, and
 * the way to find out is to measure a real response rather than to assert it in
 * a unit test. Asserting it in a unit test is how the question got closed.
 *
 * What is not in doubt, and is asserted below, is that the response schema is
 * the larger lever by some way: it is bigger than the entire static prompt, no
 * cache covers it, and there is a rung of the ladder that says the same thing
 * in a fifteenth of the bytes.
 */
import { estimateTextTokens } from '@/llm/usage';
import { buildSystemPrompt, type LlmContext } from '@/llm/prompt';
import { RESPONSE_SCHEMA, strictResponseSchema } from '@/llm/provider';
import { TOOL_NAMES } from '@/llm/contract';

/**
 * The narrowest cache minimum the Gemini family has shipped. Below this, no
 * reordering can possibly help; above it, the answer depends on which model the
 * alias resolves to today and has to be measured against a live response.
 */
const NARROWEST_KNOWN_MINIMUM = 1_024;

/**
 * The band the reachable static prefix is expected to sit in.
 *
 * Not a verdict — a tripwire. It fails when the static half of the prompt moves
 * materially in either direction, which is the moment the trade above is worth
 * re-deciding, and it says nothing about a vendor constant it cannot check.
 */
const REACHABLE_TOKENS = { min: 2_000, max: 4_000 };

const AT = Date.UTC(2026, 2, 4, 9, 0);

const bare: LlmContext = { now: AT, zone: 'Europe/Sofia', weekStart: 'monday' };

const withData = (at: number, taskCount: number): LlmContext => ({
  ...bare,
  now: at,
  openTasks: Array.from({ length: taskCount }, (_, i) => ({ title: `Task ${i}` })),
  checklistNames: ['Groceries', 'Hardware'],
  habitNames: ['Running'],
});

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/** Everything in the prompt that is not the clock and not the user's data. */
function staticProse(): string {
  return buildSystemPrompt(bare)
    .split('\n\n')
    .filter((block) => !block.startsWith('NOW\n'))
    .join('\n\n');
}

describe('prompt caching', () => {
  it('shares only the identity header between two consecutive turns', () => {
    // A minute later, and the user has one more task — which is the normal
    // case, not the pathological one: a turn that writes a row changes the
    // CONTEXT block of the turn after it.
    const first = buildSystemPrompt(withData(AT, 3));
    const second = buildSystemPrompt(withData(AT + 60_000, 4));

    const shared = commonPrefix(first, second);

    // The identity header and the JSON envelope, then the NOW block diverges.
    expect(shared).toContain('You are Ridik');
    expect(shared).not.toContain('TOOLS');
    expect(shared).not.toContain('RULES');
  });

  /* As sent today, the shared prefix cannot reach even the narrowest minimum
     any model in this family has used — so *without* a reorder, caching is
     unreachable regardless of which model the alias points at. That much is
     safe to assert, and it is all that is. */
  it('cannot cache anything at all in the order the prompt is sent', () => {
    const first = buildSystemPrompt(withData(AT, 3));
    const second = buildSystemPrompt(withData(AT + 60_000, 4));

    const shared = estimateTextTokens(commonPrefix(first, second));

    expect(shared).toBeLessThan(NARROWEST_KNOWN_MINIMUM);
  });

  /* What a reorder would put in front. Reported rather than judged: whether it
     clears the minimum is the vendor's business and changes without notice. */
  it('measures what reordering could put into a stable prefix', () => {
    const reachable = estimateTextTokens(staticProse());

    expect(reachable).toBeGreaterThan(REACHABLE_TOKENS.min);
    expect(reachable).toBeLessThan(REACHABLE_TOKENS.max);
    // Big enough to be worth measuring against a live response, which is the
    // only thing that can actually settle it.
    expect(reachable).toBeGreaterThan(NARROWEST_KNOWN_MINIMUM);
  });

  it('is bounded: no amount of user data can grow the static half', () => {
    // The reachable prefix is a compile-time constant. That is what makes the
    // number above a fact rather than a snapshot of one user's database.
    const busy: LlmContext = {
      ...bare,
      openTasks: Array.from({ length: 400 }, (_, i) => ({ title: `Task ${i}` })),
      notes: Array.from({ length: 400 }, (_, i) => ({ title: `Note ${i}`, tag: 'x' })),
      crmNames: Array.from({ length: 400 }, (_, i) => `Person ${i}`),
    };
    const withBusyData = buildSystemPrompt(busy);

    for (const block of staticProse().split('\n\n')) {
      expect(withBusyData).toContain(block);
    }
  });

  it('spends most of a request on a schema no cache covers', () => {
    // `generationConfig.responseSchema` is not a `CachedContent` field and is
    // not part of the prefix implicit caching matches — it is simply billed as
    // input, every call, forever. It is also the single largest thing in the
    // request, which is why "cache the prompt" is at best the second lever here
    // and "send the schema as `tools`" is the first.
    const schema = JSON.stringify(strictResponseSchema());
    expect(estimateTextTokens(schema)).toBeGreaterThan(estimateTextTokens(staticProse()));

    // The fallback rung says the same thing in a fifteenth of the bytes, which
    // is the measurement anyone weighing that trade should start from.
    expect(JSON.stringify(RESPONSE_SCHEMA).length).toBeLessThan(schema.length / 10);
  });

  /*
   * The heuristic every number above rests on, checked against the one real
   * measurement this repo has: on 17 August 2026 the shipped prompt plus the
   * strict schema billed at 7,240 input tokens (`TYPICAL_TURN`). A generic
   * "four characters per token" undercounts this content by nearly 9%, which
   * is the wrong direction for anything sizing a spend ceiling.
   *
   * The measurement was taken against a 28-tool contract and the contract has
   * grown since — the removal tools. So the ceiling is scaled by tool count
   * rather than raised by hand: the strict schema is the largest thing in the
   * request and it is exactly one full parameter branch per tool, so a contract
   * that gains a tool costs roughly a 28th more. A flat number here would have
   * to be edited every time the contract grows, and a number edited to make a
   * test pass stops being a measurement.
   *
   * What is still asserted, and is the actual point: the estimate never comes
   * in *under* what the provider billed.
   */
  const MEASURED_INPUT_TOKENS = 7_240;

  it('estimates tokens on the high side of what this prompt really costs', () => {
    const estimated = estimateTextTokens(
      buildSystemPrompt(bare) + JSON.stringify(strictResponseSchema()),
    );
    expect(estimated).toBeGreaterThanOrEqual(MEASURED_INPUT_TOKENS);
  });

  /*
   * The upper bound used to live on the line above, as the same tool-scaled
   * number: `estimated < 7240 * tools / 28 * 1.05`. It had to be split, and
   * what forced it is worth writing down rather than editing past.
   *
   * That ceiling is a model of how the **schema** grows — one full parameter
   * branch per tool, so a contract that gains a tool costs a 28th more — and it
   * was being asked to bound prompt *and* schema together. Prose does not grow
   * with tool count, so every word added to RULES was silently spending the
   * schema's headroom. By the time the conversation rules were written there
   * was none: the prompt measured 99.5% of its own ceiling, and the next person
   * to add a sentence of any kind would have hit it with no idea why a rule
   * about continuations was failing a test about caching.
   *
   * So the two are bounded on their own terms. Both numbers are readings taken
   * on 12 September 2026, not targets, and each has a reason for its headroom.
   */
  const SCHEMA_TOKENS_PER_TOOL = 175; // measured 162; one branch of slack.
  const PROSE_CEILING_TOKENS = 4_200; // measured 3,931; about a rule and a half.

  it('keeps the schema growing with the contract and nothing else', () => {
    const schema = estimateTextTokens(JSON.stringify(strictResponseSchema()));
    expect(schema).toBeLessThan(TOOL_NAMES.length * SCHEMA_TOKENS_PER_TOOL);
  });

  /*
   * The prose is billed on every turn forever, so it is a budget and not a
   * limit: going over is allowed, it just has to be a decision somebody takes
   * on purpose and writes a number down for. What it buys at the moment is the
   * tool list, sixteen behavioural rules and twelve worked examples.
   */
  it('keeps the static prose within its own budget', () => {
    expect(estimateTextTokens(buildSystemPrompt(bare))).toBeLessThan(PROSE_CEILING_TOKENS);
  });
});
