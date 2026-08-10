/**
 * The resilient calling layer.
 *
 * Two independent failure modes, two independent retry budgets:
 *  - **transport** (429, 5xx, dropped connection) — retried with jittered
 *    exponential backoff, because the same request will probably work later;
 *  - **schema** (the model replied with something Zod rejects) — retried by
 *    handing the model its own output plus the validator's complaints.
 *
 * `interpret` never throws. A voice turn that fails must still be able to say
 * something to the user, so every path returns a Result carrying a sentence
 * that is safe to speak.
 */
import type { Logger } from '@/core/logger';
import { AppError, err, fail, ok, toAppError, type AppErrorCode, type Result } from '@/core/result';
import { extractJson, parseLlmResponse, type LlmResponse } from '@/llm/contract';
import { buildRetryPrompt, buildSystemPrompt, type LlmContext } from '@/llm/prompt';
import {
  LlmProviderError,
  type LlmCompletion,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
} from '@/llm/provider';

export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 8_000;

export type BackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  random?: () => number;
};

/**
 * Equal-jitter backoff. Half the window is fixed so we always actually wait,
 * half is random so a room full of devices does not retry in lockstep.
 * `attempt` is the zero-based index of the attempt that just failed.
 */
export function computeBackoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? DEFAULT_BASE_DELAY_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_DELAY_MS;
  const random = options.random ?? Math.random;
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const half = ceiling / 2;
  return Math.round(half + random() * half);
}

export type LlmClientOptions = {
  provider: LlmProvider;
  logger?: Logger;
  /** Re-asks after a schema rejection. 2 means up to 3 provider calls per turn. */
  maxSchemaRetries?: number;
  /** Retries after a retryable transport error. 4 means up to 5 calls per attempt. */
  maxTransportRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  temperature?: number;
  maxOutputTokens?: number;
  /** Overrides the provider's own structured-output schema. */
  responseSchema?: unknown;
};

export type InterpretInput = {
  transcript: string;
  context: LlmContext;
  history?: LlmMessage[];
  signal?: AbortSignal;
};

export type Interpretation = {
  response: LlmResponse;
  /** The winning raw reply, kept for the llm_interactions audit trail. */
  raw: string;
  model: string;
  /** Provider time summed across every attempt. */
  latencyMs: number;
  attempts: number;
  /** Token counts the provider reported, when it reported any. */
  usage?: { input?: number | undefined; output?: number | undefined };
};

type CallState = { attempts: number; latencyMs: number };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createLlmClient(options: LlmClientOptions) {
  const { provider, logger } = options;
  const maxSchemaRetries = options.maxSchemaRetries ?? 2;
  const maxTransportRetries = options.maxTransportRetries ?? 4;
  const sleep = options.sleep ?? defaultSleep;
  const backoff: BackoffOptions = {
    baseMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    random: options.random ?? Math.random,
  };

  async function callProvider(req: LlmRequest, state: CallState): Promise<Result<LlmCompletion>> {
    for (let attempt = 0; ; attempt++) {
      state.attempts++;
      try {
        const completion = await provider.complete(req);
        state.latencyMs += completion.latencyMs;
        return ok(completion);
      } catch (error) {
        const providerError = asProviderError(error);
        const exhausted = attempt >= maxTransportRetries;
        if (!providerError.retryable || exhausted || req.signal?.aborted) {
          logger?.error('llm call failed', {
            code: providerError.code,
            status: providerError.status,
            attempts: state.attempts,
          });
          return err(toUserFacingError(providerError));
        }
        const delay = computeBackoffDelay(attempt, backoff);
        logger?.warn('llm call retrying', { code: providerError.code, delay, attempt });
        await sleep(delay);
        // Barge-in: the user re-opened the mic while we were waiting. Spending
        // another call and another 8 seconds on a turn nobody is listening to
        // costs real quota.
        if (req.signal?.aborted) {
          return err(
            toUserFacingError(
              new LlmProviderError('network', 'That request was cancelled.', { retryable: false }),
            ),
          );
        }
      }
    }
  }

  async function interpret(input: InterpretInput): Promise<Result<Interpretation>> {
    try {
      if (!provider.isConfigured()) {
        return fail('permission_denied', 'The assistant is not set up yet. Add an API key in Settings.');
      }

      const system = buildSystemPrompt(input.context);
      const messages: LlmMessage[] = [
        ...(input.history ?? []),
        { role: 'user', content: input.transcript },
      ];
      const state: CallState = { attempts: 0, latencyMs: 0 };

      for (let schemaAttempt = 0; ; schemaAttempt++) {
        const call = await callProvider(
          {
            system,
            messages: [...messages],
            responseSchema: options.responseSchema,
            temperature: options.temperature,
            maxOutputTokens: options.maxOutputTokens,
            signal: input.signal,
          },
          state,
        );
        if (!call.ok) return call;

        const raw = call.value.text;
        const json = dropNullFields(extractJson(raw));
        const parsed =
          json === null
            ? { ok: false as const, issues: ['(root): the reply was not a JSON object'], raw }
            : parseLlmResponse(json);

        if (parsed.ok) {
          return ok({
            response: parsed.value,
            raw,
            model: call.value.model,
            latencyMs: state.latencyMs,
            attempts: state.attempts,
            ...(call.value.usage ? { usage: call.value.usage } : {}),
          });
        }

        logger?.warn('llm reply rejected by schema', {
          issues: parsed.issues.slice(0, 5),
          schemaAttempt,
        });

        if (schemaAttempt >= maxSchemaRetries) {
          return fail(
            'upstream',
            "I couldn't make sense of the assistant's reply. Please try saying that again.",
            { details: { issues: parsed.issues, raw } },
          );
        }

        messages.push(
          { role: 'model', content: raw },
          { role: 'user', content: buildRetryPrompt(raw, parsed.issues) },
        );
      }
    } catch (error) {
      logger?.error('llm interpret threw', { error });
      return err(toAppError(error, 'The assistant failed unexpectedly.'));
    }
  }

  return {
    provider,
    isConfigured: () => provider.isConfigured(),
    interpret,
  };
}

export type LlmClient = ReturnType<typeof createLlmClient>;

/**
 * Structured-output modes emit every declared property and fill the ones they
 * have nothing to say about with `null` — Gemini's own RESPONSE_SCHEMA marks
 * the optional fields `nullable`. The contract distinguishes absent from null
 * and rejects the latter, so an otherwise perfect reply would burn the whole
 * schema-retry budget. Absent is what the model meant; drop the nulls.
 * Array elements are left alone: a null inside `bullets` is a real mistake.
 */
function dropNullFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNullFields);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry !== null) out[key] = dropNullFields(entry);
  }
  return out;
}

function asProviderError(error: unknown): LlmProviderError {
  if (error instanceof LlmProviderError) return error;
  return new LlmProviderError(
    'unknown',
    error instanceof Error ? error.message : 'The assistant failed.',
    { retryable: false, cause: error },
  );
}

const USER_FACING: Record<LlmProviderError['code'], { code: AppErrorCode; message?: string }> = {
  rate_limited: { code: 'rate_limited', message: 'The assistant is busy right now. Try again in a moment.' },
  unauthorized: { code: 'permission_denied', message: 'The assistant rejected our API key. Check it in Settings.' },
  network: { code: 'offline', message: "I couldn't reach the assistant. Check your connection." },
  // bad_request already carries a specific, readable reason from the provider.
  bad_request: { code: 'upstream' },
  server: { code: 'upstream', message: 'The assistant is having trouble. Please try again.' },
  unknown: { code: 'upstream', message: 'The assistant is having trouble. Please try again.' },
};

/** Provider vocabulary to something the app can speak out loud (spec 5.4). */
function toUserFacingError(error: LlmProviderError): AppError {
  const mapped = USER_FACING[error.code];
  return new AppError(mapped.code, mapped.message ?? error.message, {
    cause: error,
    retryable: error.retryable,
    details: { providerCode: error.code, status: error.status },
  });
}
