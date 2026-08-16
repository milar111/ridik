/**
 * Google Gemini over plain REST.
 *
 * No SDK: the official client pulls in Node polyfills that bloat a React Native
 * bundle, and this is one endpoint with one response shape.
 */
import { now } from '@/core/clock';
import { TOOL_NAMES } from '@/llm/contract';
import { strictResponseSchema } from './geminiSchema';
import {
  LlmProviderError,
  llmErrorFromHttpStatus,
  type LlmCompletion,
  type LlmProvider,
  type LlmRequest,
} from './types';

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
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
   * unconditional saving and is not one: at $0.25/M input it saves $0.00116 a
   * call, and one extra schema repair — which resends the rejected reply plus
   * the validator's complaints — costs $0.00259. The break-even is an extra
   * repair on 45% of requests, and no turn has ever been taken against a real
   * key, so that rate is unmeasured.
   *
   * Hence a dial rather than a decision. `llm_usage` already records `calls`
   * and `requests`, so calls-per-request IS the repair rate: run a while on
   * each rung and the arithmetic answers itself.
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
  };
};

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
function rejectsOurSchema(status: number, detail: string): boolean {
  return status === 400 && /schema/i.test(detail);
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
        const schema = onLadder ? rungs[rung] : pinned;
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
          if (onLadder && rung < rungs.length - 1 && rejectsOurSchema(response.status, detail)) {
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
            output: payload.usageMetadata?.candidatesTokenCount,
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
