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
import { MODEL_RATES, estimateCostMicros } from '../usage';
import { strictResponseSchema } from '../provider/geminiSchema';
import {
  DEFAULT_GEMINI_MODEL,
  createGeminiProvider,
  RESPONSE_SCHEMA,
} from '../provider/gemini';

/** What `estimateTextTokens` uses; kept here so the two cannot silently diverge. */
const CHARS_PER_TOKEN = 3.6;

const tokensOf = (value: unknown): number =>
  Math.round(JSON.stringify(value).length / CHARS_PER_TOKEN);

describe('the schema ladder', () => {
  // An explicit version, never the default: `gemini-flash-latest` is an alias
  // Google does not price, so it deliberately has no row and pricing against it
  // would be pricing a guess.
  const rate = MODEL_RATES['gemini-3.1-flash-lite']!;

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
    // validator's issues, then pays for a second completion. Measured at ~300
    // extra input tokens, not the 1,300 first assumed — the echoed reply and
    // retry prompt are small and the cost is dominated by resending the base
    // prompt. Transport retries are excluded entirely: `client.ts` counts them
    // as attempts, not calls, because a 429 or 5xx returns no tokens and bills
    // nothing.
    const repairInput = (7_240 + 300) * (rate.inputPerMillion / 1_000_000);
    const repairOutput = 300 * (rate.outputPerMillion / 1_000_000);
    const repair = repairInput + repairOutput;

    const breakEven = saved / repair;

    // ~51%. The estimated cost of dropping the strict schema is a repair rate
    // moving from ~5% (constrained decoding: the model cannot emit malformed
    // JSON, so only Zod's cross-field rules reject) to ~12% (syntax and shape
    // errors return). That is a 7-point rise against a 51-point budget — a 7x
    // margin, not the coin flip it looked like before transport retries were
    // correctly excluded from the repair cost.
    //
    // Still an estimate: no turn has run against a real key. The band is a
    // tripwire for when the trade changes, not a verdict on it.
    expect(breakEven).toBeGreaterThan(0.35);
    expect(breakEven).toBeLessThan(0.7);
  });

  /* The provider still defaults to strict when nobody says otherwise — the
     choice to ship rung 1 is the app's, made in `settings.llmSchemaRung`, so a
     caller that constructs a provider directly gets the conservative one. */
  it('starts on the strict schema unless told otherwise', () => {
    expect(createGeminiProvider({ apiKey: 'k' }).schemaRung).toBe(0);
    expect(createGeminiProvider({ apiKey: 'k', startRung: 1 }).schemaRung).toBe(1);
  });

  /* What rung 1 keeps, and why the trade is narrower than "drop the schema".
     A turn is still usable without the strict rung: only `parameters` is
     unconstrained, and zod rejects a bad one into the repair loop. */
  it('still constrains the envelope on the rung the app ships', () => {
    const envelope = RESPONSE_SCHEMA as { properties: Record<string, unknown> };
    expect(envelope.properties.actions).toBeDefined();
    expect(JSON.stringify(RESPONSE_SCHEMA)).toContain('tool_name');
  });

  /* A hand-edited setting must not index off the end of the ladder: the schema
     would come back `undefined` and Gemini answers that with a 400, which
     reaches the user as an outage rather than as a bad setting. */
  it('clamps a rung that does not exist rather than sending nothing', () => {
    expect(createGeminiProvider({ apiKey: 'k', startRung: 99 }).schemaRung).toBeLessThanOrEqual(2);
    expect(createGeminiProvider({ apiKey: 'k', startRung: -5 }).schemaRung).toBe(0);
  });
});

describe('the rate table cannot silently bill nothing', () => {
  /* The bug this replaces: an unrecognised model returned 0, so a spend cap
     counting free requests never tripped. A rename upstream or a value typed
     into the developer screen was enough to switch the protection off. */
  it('charges an unknown model at the most expensive known rate', () => {
    const known = estimateCostMicros('gemini-2.5-flash-lite', 10_000, 1_000);
    const unknown = estimateCostMicros('gemini-9-whatever', 10_000, 1_000);

    expect(unknown).toBeGreaterThan(0);
    expect(unknown).toBeGreaterThanOrEqual(known);
  });

  /* `gemini-flash-latest` is the default and Google does not price it: it is an
     alias over a family spanning 0.10 to 1.50 per million. It must land on the
     fallback rather than on a number somebody guessed. */
  it('does not pretend to know what a moving alias costs', () => {
    expect(MODEL_RATES['gemini-flash-latest']).toBeUndefined();
    expect(estimateCostMicros('gemini-flash-latest', 10_000, 1_000)).toBeGreaterThan(0);
  });

  it('never carries a free or negative rate', () => {
    for (const [model, rate] of Object.entries(MODEL_RATES)) {
      expect({ model, ok: rate.inputPerMillion > 0 }).toEqual({ model, ok: true });
      expect({ model, ok: rate.outputPerMillion > 0 }).toEqual({ model, ok: true });
    }
  });

  /* The family prices a cached token at a tenth of a fresh one; a row that
     drifts off that ratio is a row where only one of the two was updated. */
  it('keeps the cached discount at a tenth of its own input rate', () => {
    for (const [model, rate] of Object.entries(MODEL_RATES)) {
      const ratio = (rate.cachedInputPerMillion ?? rate.inputPerMillion) / rate.inputPerMillion;
      expect({ model, ratio: Math.round(ratio * 100) / 100 }).toEqual({ model, ratio: 0.1 });
    }
  });
});

describe('the model is pinned, not aliased', () => {
  /**
   * `gemini-flash-latest` shipped as the default and resolved, when finally
   * measured against a real key, to `gemini-3.7-flash` — the top of the Flash
   * family, at 3x the input price of the Flash-Lite every cost model in this
   * repo was built on, and double again from 1 January 2027.
   *
   * The deeper problem was not the price but that an alias can move without a
   * deploy. A spend cap cannot defend against a rate change, because the cap is
   * denominated in the number that moved.
   */
  it('names a version rather than a moving alias', () => {
    expect(DEFAULT_GEMINI_MODEL).not.toMatch(/latest/);
    expect(DEFAULT_GEMINI_MODEL).toMatch(/^gemini-\d/);
  });

  /* And whatever it is pinned to must be priced, or `estimateCostMicros` falls
     to the pessimistic fallback and every figure in the app is a guess. */
  it('is a model the rate table can price', () => {
    expect(MODEL_RATES[DEFAULT_GEMINI_MODEL]).toBeDefined();
  });
});
