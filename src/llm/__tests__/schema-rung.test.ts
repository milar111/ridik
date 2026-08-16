/**
 * The strict schema is the biggest line item in a request, and dropping it is
 * not the saving it looks like.
 *
 * It is ~4,626 tokens of every call — more than half the input — and it buys
 * constrained decoding across 22 tools. The envelope rung below it leaves
 * `parameters` free-form and leans on the schema-repair loop instead, which
 * makes "just send the small one" read like free money.
 *
 * It is not free, because a repair is a whole extra billable call carrying the
 * rejected reply and the validator's complaints, so it costs more than the
 * tokens the smaller schema saved. The arithmetic below is the reason the
 * default is still 0, and it is asserted rather than written in a comment so
 * that a future change to the model rates or the schema size re-opens the
 * question instead of silently invalidating the conclusion.
 *
 * The dial exists so the answer can be measured on a real key: `llm_usage`
 * records `calls` and `requests`, and calls-per-request IS the repair rate.
 */
import { MODEL_RATES } from '../usage';
import { strictResponseSchema } from '../provider/geminiSchema';
import { createGeminiProvider, RESPONSE_SCHEMA } from '../provider/gemini';

/** What `estimateTextTokens` uses; kept here so the two cannot silently diverge. */
const CHARS_PER_TOKEN = 3.6;

const tokensOf = (value: unknown): number =>
  Math.round(JSON.stringify(value).length / CHARS_PER_TOKEN);

describe('the schema ladder', () => {
  const rate = MODEL_RATES['gemini-flash-latest']!;

  it('spends most of a request on the strict schema', () => {
    const strict = tokensOf(strictResponseSchema());
    const envelope = tokensOf(RESPONSE_SCHEMA);

    expect(strict).toBeGreaterThan(3_500);
    // The envelope is the cheap rung by an order of magnitude, which is what
    // makes the trade tempting in the first place.
    expect(envelope).toBeLessThan(strict / 10);
  });

  /**
   * The number that decides it. If dropping the strict schema causes an extra
   * repair on more than this share of requests, it costs money rather than
   * saving it.
   */
  it('breaks even at a repair rate well below certainty', () => {
    const strict = tokensOf(strictResponseSchema());
    const saved = strict * (rate.inputPerMillion / 1_000_000);

    // A repair resends the whole turn plus the rejected reply and the
    // validator's issues, then pays for a second completion.
    const repairInput = (7_240 + 1_300) * (rate.inputPerMillion / 1_000_000);
    const repairOutput = 300 * (rate.outputPerMillion / 1_000_000);
    const repair = repairInput + repairOutput;

    const breakEven = saved / repair;

    // Between a third and two thirds: high enough that dropping the schema is
    // not obviously wrong, low enough that it is nowhere near obviously right.
    // If this ever drifts outside that band the trade has genuinely changed
    // and the default deserves revisiting.
    expect(breakEven).toBeGreaterThan(0.3);
    expect(breakEven).toBeLessThan(0.7);
  });

  it('starts on the strict schema unless told otherwise', () => {
    expect(createGeminiProvider({ apiKey: 'k' }).schemaRung).toBe(0);
    expect(createGeminiProvider({ apiKey: 'k', startRung: 1 }).schemaRung).toBe(1);
  });

  /* A hand-edited setting must not index off the end of the ladder: the schema
     would come back `undefined` and Gemini answers that with a 400, which
     reaches the user as an outage rather than as a bad setting. */
  it('clamps a rung that does not exist rather than sending nothing', () => {
    expect(createGeminiProvider({ apiKey: 'k', startRung: 99 }).schemaRung).toBeLessThanOrEqual(2);
    expect(createGeminiProvider({ apiKey: 'k', startRung: -5 }).schemaRung).toBe(0);
  });
});
