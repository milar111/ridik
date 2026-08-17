/**
 * Google Gemini over plain REST.
 *
 * No SDK: the official client pulls in Node polyfills that bloat a React Native
 * bundle, and this is one endpoint with one response shape.
 */
import { now } from '@/core/clock';
import { TOOL_NAMES } from '@/llm/contract';
import { narrowToolNames, strictResponseSchema } from './geminiSchema';
import {
  LlmProviderError,
  llmErrorFromHttpStatus,
  type LlmCompletion,
  type LlmProvider,
  type LlmRequest,
} from './types';

/**
 * Pinned, and pinned to the model the price of this app was built on.
 *
 * `gemini-flash-latest` is what shipped. On 16 August 2026 the first call ever
 * made with a real key reported `modelVersion: gemini-3.7-flash` — the top of
 * the Flash family, at $0.75/M input and $3.75/M output, doubling on 1 January
 * 2027. Every figure in the plan assumed a Flash-Lite at $0.25.
 *
 * That gap is not a rounding error, it is the business model. At 3.7 Flash a
 * subscriber burning the 1,000 credits of the upper tier costs $10.58 against
 * $7.60 of net revenue from January: the plan loses money on exactly the
 * customer it is designed to attract. On this model the same burn costs $1.93.
 *
 * So the choice is not "cheaper if convenient". The cheaper model is the
 * assumption the ladder rests on, and 3.7 Flash would mean repricing rather
 * than saving.
 *
 * The cost of the choice is answer quality: a smaller model picking among 28
 * tools with structured output may need the repair loop more often. Two things
 * make that measurable rather than a gamble — `llm_usage` records `calls` and
 * `requests`, so calls-over-requests IS the repair rate, and the tool set the
 * model has to choose from is being narrowed per call, which shrinks the job
 * this model has to do.
 *
 * An explicit version, never an alias: an alias can move without a deploy, and
 * a spend cap cannot defend against a rate change because the cap is
 * denominated in the number that moved.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_TIMEOUT_MS = 30_000;

export type GeminiProviderOptions = {
  /** A getter keeps a rotated or lazily-loaded key working without rebuilding. */
  apiKey: string | (() => string | null | undefined);
  model?: string;
  baseUrl?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** 0 disables the client-side timeout. */
  timeoutMs?: number;
  /**
   * Pins the schema instead of letting the provider pick one. `null` disables
   * structured output entirely; anything else is sent verbatim. Leaving it
   * unset — the normal case — hands the provider the ladder below.
   */
  responseSchema?: unknown;
  /**
   * Where the schema ladder starts. 0 is the strict schema, 1 the envelope.
   *
   * The strict schema is ~4,626 tokens of every call and buys constrained
   * decoding across 22 tools; the envelope leaves `parameters` free-form and
   * leans on the repair loop instead. Dropping it therefore looks like an
   * unconditional saving. It is not unconditional, but it is a good trade.
   *
   * At $0.25/M input it saves $0.00116 a call. One extra schema repair costs
   * $0.00228 — the rejected reply and the validator's complaints are only
   * ~300 tokens, and the cost is dominated by resending the base prompt.
   * Transport retries are excluded: `client.ts` counts a 429 as an attempt,
   * not a call, because it returns no tokens and bills nothing. Break-even is
   * therefore an extra repair on **51%** of requests.
   *
   * What the envelope actually gives up is narrower than it sounds. It still
   * constrains valid JSON, a real tool name and an actions array; only
   * `parameters` goes free-form, and zod catches those. So the expected repair
   * rate moves from ~5% (constrained decoding: only cross-field rules can
   * reject) to ~12% — 7 points against a 51-point budget.
   *
   * Still a dial, because those rates are reasoned and not measured: no turn
   * has run against a real key. `llm_usage` records `calls` and `requests`, so
   * calls-per-request IS the repair rate. If it settles above ~1.5 on rung 1,
   * put it back.
   */
  startRung?: number;
};

/** Exposes which rung of the schema ladder is in force, for tests and diagnostics. */
export type GeminiProvider = LlmProvider & { readonly schemaRung: number };

/**
 * The fallback rung: the envelope only, with `parameters` left free-form.
 *
 * This was the whole schema until the contract learned to generate its own
 * (see `./geminiSchema`), and it stays because it is the one shape this app has
 * ever had accepted by the API. It constrains the parts that matter most for a
 * turn to be usable at all — valid JSON, a real tool name, an actions array —
 * without a single keyword beyond the oldest, safest corner of the subset.
 */
export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    conversational_feedback: {
      type: 'STRING',
      description: 'One short sentence spoken back to the user.',
      nullable: true,
    },
    requires_user_input: {
      type: 'BOOLEAN',
      description: 'True only when an essential parameter is missing.',
      nullable: true,
    },
    clarification: {
      type: 'OBJECT',
      nullable: true,
      properties: {
        question: { type: 'STRING' },
        pending: { type: 'STRING', nullable: true },
      },
      required: ['question'],
    },
    actions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          tool_name: { type: 'STRING', enum: [...TOOL_NAMES] },
          parameters: {
            type: 'OBJECT',
            description: 'Parameters for the named tool, exactly as documented.',
          },
        },
        required: ['tool_name', 'parameters'],
      },
    },
  },
  required: ['actions'],
} as const;

type GeminiPart = { text?: string };

type GeminiPayload = {
  candidates?: {
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    /** Tokens of `promptTokenCount` that were served from a prompt cache. */
    cachedContentTokenCount?: number;
    /**
     * Reasoning tokens, on a thinking-capable model. Billed at the OUTPUT rate
     * — six times input on this family — and NOT included in
     * `candidatesTokenCount`, which counts only the reply the caller can see.
     */
    thoughtsTokenCount?: number;
  };
};

/**
 * Adds two optional counts, staying `undefined` when neither was reported.
 *
 * Undefined is not zero here: `usage` being absent means "the provider said
 * nothing", which the meter treats differently from "it said none". Collapsing
 * them would record a free turn for a call that billed.
 */
function sumTokens(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

const FINISH_MESSAGES: Record<string, string> = {
  SAFETY: 'Gemini refused that request on safety grounds.',
  RECITATION: 'Gemini stopped because the reply was reciting protected content.',
  BLOCKLIST: 'Gemini blocked that request.',
  PROHIBITED_CONTENT: 'Gemini refused that request.',
  SPII: 'Gemini refused because the reply contained sensitive personal information.',
  MALFORMED_FUNCTION_CALL: 'Gemini produced an unusable tool call.',
};

/**
 * A 400 that mentions the schema is the API telling us this shape is more than
 * it will decode against — too complex, or a keyword this model does not know.
 * Every other 400 is about the request itself and must not be retried.
 */
/**
 * Whether a 400 means "I will not take that schema".
 *
 * It used to require the word "schema" in the message. The first request this
 * app ever made with a real key came back:
 *
 *     400  { "error": { "message": "Request contains an invalid argument.",
 *                       "status": "INVALID_ARGUMENT" } }
 *
 * No mention of a schema, no field path, nothing. So the guard written for
 * exactly this case returned false, the ladder never stepped down, and **every
 * single turn failed permanently** — on a code path whose whole purpose was to
 * survive this. Rung 0 is 16.6 kB of translated Zod and `gemini-3.1-flash-lite`
 * rejects it outright; rung 1, at 1.2 kB, is accepted. The app could not talk
 * to Gemini at all and the mock provider hid it.
 *
 * So the test is the *shape* of the request rather than the wording of the
 * reply: a 400 on a call that carried a response schema is treated as the
 * schema being refused. Google does not document that message and is free to
 * change it; what it cannot change is that we sent a schema and got a 400.
 *
 * The cost of being wrong is small and one-directional. If a 400 was really
 * about something else, stepping down sends a smaller request that fails the
 * same way and the turn ends as it would have — one extra call. Not stepping
 * down when we should is the utterance lost.
 */
function rejectsOurSchema(status: number, sentSchema: boolean): boolean {
  return status === 400 && sentSchema;
}

export function createGeminiProvider(options: GeminiProviderOptions): GeminiProvider {
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const baseUrl = (options.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * Strongest first. The strict schema is the point of the exercise, but it is
   * also the largest thing this app has ever sent Google and no request has yet
   * been made with a real key — so a rejection steps down a rung and retries
   * instead of ending the turn. Losing the schema costs precision the repair
   * loop can recover; a hard 400 costs the user the utterance.
   *
   * Built lazily, and defensively: a zod release that emits a keyword the
   * translator has not been taught throws, and the ladder simply starts one
   * rung lower rather than taking the assistant down with it.
   */
  const ladder = (): readonly unknown[] => {
    try {
      return [strictResponseSchema(), RESPONSE_SCHEMA, null];
    } catch {
      return [RESPONSE_SCHEMA, null];
    }
  };

  const rungs = options.responseSchema === undefined ? ladder() : null;
  // Clamped, not trusted: a hand-edited setting must not index off the end of
  // the ladder and send `undefined` as the schema, which Gemini rejects with a
  // 400 that reads as an outage.
  let rung = Math.min(Math.max(options.startRung ?? 0, 0), rungs ? rungs.length - 1 : 0);

  const readKey = (): string => {
    const raw = typeof options.apiKey === 'function' ? options.apiKey() : options.apiKey;
    return (raw ?? '').trim();
  };

  const doFetch: typeof fetch = (input, init) => (options.fetchImpl ?? globalThis.fetch)(input, init);

  return {
    name: 'gemini',
    model,

    get schemaRung() {
      return rung;
    },

    isConfigured: () => readKey().length > 0,

    async complete(req: LlmRequest): Promise<LlmCompletion> {
      const apiKey = readKey();
      if (!apiKey) {
        throw new LlmProviderError('unauthorized', 'No Gemini API key is configured.', {
          retryable: false,
        });
      }

      // `null` is the caller saying "no schema at all"; only `undefined` means
      // "you decide". `??` would have collapsed the two and re-armed the default.
      const pinned = req.responseSchema !== undefined ? req.responseSchema : options.responseSchema;
      const onLadder = rungs !== null && req.responseSchema === undefined;

      const startedAt = now();
      for (;;) {
        const rungSchema = onLadder ? rungs[rung] : pinned;
        // Per call, and on whichever rung is in force. Narrowing the enum is
        // constrained decoding over a small surface: on the strict rung it
        // deletes whole tool branches, which is most of what a request costs.
        const schema =
          rungSchema && req.tools ? narrowToolNames(rungSchema, req.tools) : rungSchema;
        // Prompt caching, and why this request is not reordered to chase it.
        //
        // Measured on this repo (src/llm/__tests__/prompt-cache.test.ts keeps
        // the numbers honest): a full turn is ~29.4 kB — a 12.8 kB system
        // instruction plus a 16.7 kB `responseSchema` — about 7,300 tokens.
        //
        //  - Caching discounts a *prefix*, and `responseSchema` is not part of
        //    one. `CachedContent` holds `contents`, `systemInstruction`,
        //    `tools` and `toolConfig`; there is no `generationConfig` on it,
        //    and implicit caching keys on the same fields. The 16.7 kB is
        //    billed as input on every call and cannot be cached where it sits.
        //  - What is left — the static prose of the system instruction — is
        //    9,904 characters, ~2,500 tokens, and it is a compile-time
        //    constant that no amount of user data can grow. Gemini 3.x Flash
        //    needs 4,096 tokens before a prefix is cacheable at all, so moving
        //    NOW and CONTEXT to the tail would buy a prefix that still never
        //    caches. Reordering was therefore deliberately not done.
        //
        // The move that would change the arithmetic is sending the strict
        // schema as `tools[].functionDeclarations` instead: `tools` *is* a
        // cached field, which would put ~6,900 tokens inside the prefix. That
        // is a response-mode change (function calls, not JSON text), not a
        // reorder, and it needs a real key to verify. Until then the honest
        // number for cache savings on this path is zero — which is exactly
        // what `usage.cached` below will keep reporting.
        const body = {
          systemInstruction: { parts: [{ text: req.system }] },
          contents: req.messages.map((m) => ({ role: m.role, parts: [{ text: m.content }] })),
          generationConfig: {
            temperature: req.temperature ?? DEFAULT_TEMPERATURE,
            ...(req.maxOutputTokens === undefined ? {} : { maxOutputTokens: req.maxOutputTokens }),
            ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {}),
          },
        };

        const response = await send(
          // The key travels in a header: query strings end up in proxy logs and
          // crash reports, and this one unlocks the user's whole quota.
          `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
          apiKey,
          body,
          req.signal,
        );

        if (!response.ok) {
          const detail = await describeHttpError(response);
          if (onLadder && rung < rungs.length - 1 && rejectsOurSchema(response.status, schema != null)) {
            // Remembered for the life of the provider: the next turn must not
            // pay for the same rejection again.
            rung += 1;
            continue;
          }
          throw llmErrorFromHttpStatus(response.status, detail);
        }

        const payload = await readPayload(response);
        const text = extractText(payload);
        const cached = payload.usageMetadata?.cachedContentTokenCount;

        return {
          text,
          model,
          latencyMs: now() - startedAt,
          usage: {
            input: payload.usageMetadata?.promptTokenCount,
            /**
             * The reply plus whatever the model thought on the way to it.
             *
             * `candidatesTokenCount` is only the visible answer. A thinking
             * model also returns `thoughtsTokenCount`, billed at the same
             * output rate, and reading just the first number made every
             * reasoning token invisible — to the meter, to the cost cap, to
             * the free trial, and to every estimate built on top of them.
             * Spend that cannot be seen is spend that cannot be capped, which
             * is the one failure this whole meter exists to prevent.
             */
            output: sumTokens(
              payload.usageMetadata?.candidatesTokenCount,
              payload.usageMetadata?.thoughtsTokenCount,
            ),
            // Only when Google actually reported it. Recorded rather than
            // ignored because it is the one number that says whether prompt
            // caching is doing anything; see the note above `body`.
            ...(typeof cached === 'number' ? { cached } : {}),
          },
        };
      }
    },
  };

  async function send(
    url: string,
    apiKey: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : undefined;
    const forwardAbort = () => controller.abort();
    // A signal aborted before we got here never fires the event again.
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', forwardAbort);

    try {
      return await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new LlmProviderError('network', 'The assistant took too long to reply.', {
          cause: error,
        });
      }
      if (signal?.aborted) {
        throw new LlmProviderError('network', 'That request was cancelled.', {
          retryable: false,
          cause: error,
        });
      }
      throw new LlmProviderError('network', 'Could not reach the assistant.', { cause: error });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }
}

async function describeHttpError(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '');
  let detail = raw.slice(0, 300);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    // Non-JSON error bodies (HTML gateway pages) keep their truncated text.
  }
  return detail ? `Gemini returned ${response.status}: ${detail}` : `Gemini returned ${response.status}.`;
}

async function readPayload(response: Response): Promise<GeminiPayload> {
  try {
    return (await response.json()) as GeminiPayload;
  } catch (error) {
    throw new LlmProviderError('server', 'Gemini sent a reply we could not read.', { cause: error });
  }
}

function extractText(payload: GeminiPayload): string {
  const blockReason = payload.promptFeedback?.blockReason;
  if (blockReason) {
    throw new LlmProviderError('bad_request', `Gemini blocked that request (${blockReason}).`, {
      retryable: false,
    });
  }

  const candidate = payload.candidates?.[0];
  if (!candidate) throw new LlmProviderError('server', 'Gemini returned no answer.');

  const finish = candidate.finishReason;
  if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') {
    throw new LlmProviderError(
      'bad_request',
      FINISH_MESSAGES[finish] ?? `Gemini stopped early (${finish}).`,
      { retryable: false },
    );
  }

  const text = (candidate.content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join('')
    .trim();

  if (!text) {
    if (finish === 'MAX_TOKENS') {
      throw new LlmProviderError('bad_request', 'Gemini ran out of room before answering.', {
        retryable: false,
      });
    }
    throw new LlmProviderError('server', 'Gemini returned an empty answer.');
  }
  return text;
}
