/**
 * Google Gemini over plain REST.
 *
 * No SDK: the official client pulls in Node polyfills that bloat a React Native
 * bundle, and this is one endpoint with one response shape.
 */
import { now } from '@/core/clock';
import { TOOL_NAMES } from '@/llm/contract';
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
  /** Applied when a request carries no schema of its own; null disables it. */
  responseSchema?: unknown;
};

/**
 * Gemini's structured-output dialect: a subset of OpenAPI with uppercase type
 * names and no `oneOf`, `$ref` or `additionalProperties`. Our action list is a
 * discriminated union, which that subset cannot express, so `parameters` is a
 * free-form object here and Zod does the real validation on the way in.
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
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

const FINISH_MESSAGES: Record<string, string> = {
  SAFETY: 'Gemini refused that request on safety grounds.',
  RECITATION: 'Gemini stopped because the reply was reciting protected content.',
  BLOCKLIST: 'Gemini blocked that request.',
  PROHIBITED_CONTENT: 'Gemini refused that request.',
  SPII: 'Gemini refused because the reply contained sensitive personal information.',
  MALFORMED_FUNCTION_CALL: 'Gemini produced an unusable tool call.',
};

export function createGeminiProvider(options: GeminiProviderOptions): LlmProvider {
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const baseUrl = (options.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultSchema = options.responseSchema === undefined ? RESPONSE_SCHEMA : options.responseSchema;

  const readKey = (): string => {
    const raw = typeof options.apiKey === 'function' ? options.apiKey() : options.apiKey;
    return (raw ?? '').trim();
  };

  const doFetch: typeof fetch = (input, init) => (options.fetchImpl ?? globalThis.fetch)(input, init);

  return {
    name: 'gemini',
    model,

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
      const schema = req.responseSchema === undefined ? defaultSchema : req.responseSchema;
      const body = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: req.messages.map((m) => ({ role: m.role, parts: [{ text: m.content }] })),
        generationConfig: {
          temperature: req.temperature ?? DEFAULT_TEMPERATURE,
          ...(req.maxOutputTokens === undefined ? {} : { maxOutputTokens: req.maxOutputTokens }),
          ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {}),
        },
      };

      const startedAt = now();
      const response = await send(
        // The key travels in a header: query strings end up in proxy logs and
        // crash reports, and this one unlocks the user's whole quota.
        `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
        apiKey,
        body,
        req.signal,
      );

      if (!response.ok) {
        throw llmErrorFromHttpStatus(response.status, await describeHttpError(response));
      }

      const payload = await readPayload(response);
      const text = extractText(payload);

      return {
        text,
        model,
        latencyMs: now() - startedAt,
        usage: {
          input: payload.usageMetadata?.promptTokenCount,
          output: payload.usageMetadata?.candidatesTokenCount,
        },
      };
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
