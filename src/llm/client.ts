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
 *
 * Two ceilings sit over both budgets. The retry ladders multiply — a transport
 * ladder inside every schema attempt — so a turn that hiccups in both ways at
 * once used to be able to spend fifteen provider calls without anyone asking
 * for it. `maxCallsPerTurn` is the flat number nobody can exceed. And when the
 * schema budget really is spent, the turn degrades to the offline engine rather
 * than being thrown away: three malformed replies mean the model cannot answer
 * this utterance, and a note the user can edit beats losing what they said.
 */
import type { Logger } from '@/core/logger';
import { AppError, err, fail, ok, toAppError, type AppErrorCode, type Result } from '@/core/result';
import { extractJson, parseLlmResponse, type LlmResponse, type ToolName } from '@/llm/contract';
import { buildRetryPrompt, buildSystemPrompt, type LlmContext } from '@/llm/prompt';
import { pickTools } from '@/llm/toolPicker';
import {
  fallbackInterpret,
  LlmProviderError,
  type LlmCompletion,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
} from '@/llm/provider';

export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 8_000;

/**
 * Every provider call a single turn may make, across both retry ladders.
 *
 * Six is the transport ladder (five calls) plus one repair — enough that a
 * flaky connection and one confused reply can both be survived in the same
 * turn, and few enough that nothing the user says can quietly cost fifteen
 * requests of someone's quota.
 */
export const DEFAULT_MAX_CALLS_PER_TURN = 6;

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
  /** Hard ceiling over both ladders combined. */
  maxCallsPerTurn?: number;
  /**
   * Whether an exhausted schema budget degrades to the offline engine. On by
   * default; a caller that would rather hear the failure can turn it off.
   */
  offlineFallback?: boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  temperature?: number;
  maxOutputTokens?: number;
  /** Overrides the provider's own structured-output schema. */
  responseSchema?: unknown;
  /**
   * Whether a self-contained utterance may be offered fewer than all 28 tools.
   *
   * On by default. Off is for measuring the difference and for a caller that
   * would rather pay for the full surface every time; `pickTools` already
   * refuses on its own whenever it is not sure, so this is a dial rather than
   * the safety mechanism.
   */
  narrowTools?: boolean;
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
  /**
   * Provider calls that actually returned a completion — the billable ones.
   * A transport failure produced no tokens and no charge, so it is an
   * `attempt` but not a `call`. One utterance can bill several: each rung of
   * the schema-repair ladder is a full request, and each carries more history
   * than the last.
   */
  calls: number;
  /**
   * Token counts the provider reported, **summed across every call this turn
   * made**. Reporting only the last one meant a turn that repaired twice was
   * metered at a third of what it cost.
   *
   * `cached` is the slice of `input` that came from a prompt cache, carried all
   * the way to the meter so a caching change can be judged on evidence.
   */
  usage?: {
    input?: number | undefined;
    cached?: number | undefined;
    output?: number | undefined;
  };
  /**
   * Set when the model never produced a valid reply and the offline engine
   * answered instead. The response is real and safe to apply; it is just much
   * less clever than the one the user was expecting, and the audit trail has to
   * say so or this is invisible for ever.
   */
  degraded?: true;
  /** Why we gave up, for the audit trail. Present only when `degraded`. */
  issues?: string[];
};

type CallState = {
  attempts: number;
  /** Calls that returned a completion, i.e. the ones the provider billed. */
  calls: number;
  latencyMs: number;
  /** The last provider that actually answered; null until one does. */
  model: string | null;
  usage: LlmCompletion['usage'];
};

/**
 * Tokens are additive across a turn and the meter is the only thing that sees
 * them, so they are summed here rather than overwritten. `undefined` stays
 * `undefined` — a provider that reports nothing must not be recorded as zero,
 * which would read as "this call was free".
 */
function addUsage(a: LlmCompletion['usage'], b: LlmCompletion['usage']): LlmCompletion['usage'] {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const input = sum(a.input, b.input);
  const cached = sum(a.cached, b.cached);
  const output = sum(a.output, b.output);
  return {
    ...(input === undefined ? {} : { input }),
    // A subset of `input` on each call, so it stays a subset of the sum. A
    // repaired turn caches the same prefix twice and both hits are real.
    ...(cached === undefined ? {} : { cached }),
    ...(output === undefined ? {} : { output }),
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createLlmClient(options: LlmClientOptions) {
  const { provider, logger } = options;
  const maxSchemaRetries = options.maxSchemaRetries ?? 2;
  const maxTransportRetries = options.maxTransportRetries ?? 4;
  const maxCallsPerTurn = options.maxCallsPerTurn ?? DEFAULT_MAX_CALLS_PER_TURN;
  const offlineFallback = options.offlineFallback ?? true;
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
        state.calls++;
        state.latencyMs += completion.latencyMs;
        state.model = completion.model;
        state.usage = addUsage(state.usage, completion.usage);
        return ok(completion);
      } catch (error) {
        const providerError = asProviderError(error);
        const exhausted = attempt >= maxTransportRetries || state.attempts >= maxCallsPerTurn;
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

      const messages: LlmMessage[] = [
        ...(input.history ?? []),
        { role: 'user', content: input.transcript },
      ];
      const narrowed = narrowingFor(input);
      // The prompt and the decoder move together. A narrowed turn says which
      // tools are live and what to do when none of them fits; leaving that
      // paragraph in place after the constraint is gone would describe a rule
      // nothing is enforcing.
      let system = narrowed
        ? buildSystemPrompt(input.context, { tools: narrowed })
        : buildSystemPrompt(input.context);
      const state: CallState = {
        attempts: 0,
        calls: 0,
        latencyMs: 0,
        model: null,
        usage: undefined,
      };

      for (let schemaAttempt = 0; ; schemaAttempt++) {
        // The transport ladder may have eaten the budget on its own.
        if (state.attempts >= maxCallsPerTurn) {
          return giveUp(input, state, ['(root): out of provider calls for this turn'], null);
        }

        // A repair is the app's own admission that the first request did not
        // work. Whatever the validator objected to, the second ask goes out
        // with nothing of ours narrowing it — an enum is the one part of a
        // request the model cannot argue with, so it is the first thing to let
        // go of rather than the last.
        const tools = schemaAttempt === 0 ? narrowed : null;
        if (schemaAttempt === 1 && narrowed) {
          logger?.info('widening the tool set for the repair');
          system = buildSystemPrompt(input.context);
        }

        const call = await callProvider(
          {
            system,
            messages: [...messages],
            responseSchema: options.responseSchema,
            ...(tools ? { tools } : {}),
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
            calls: state.calls,
            // Every call of the repair ladder, not just the one that worked.
            ...(state.usage ? { usage: state.usage } : {}),
          });
        }

        logger?.warn('llm reply rejected by schema', {
          issues: parsed.issues.slice(0, 5),
          schemaAttempt,
        });

        if (schemaAttempt >= maxSchemaRetries) {
          return giveUp(input, state, parsed.issues, raw);
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

  /**
   * The end of the repair loop.
   *
   * Three replies the validator would not take mean the model cannot answer
   * *this* utterance; a fourth ask would spend another second and another
   * request to be told the same thing. What the user said is still worth
   * keeping, so the offline engine takes the turn — the same rule engine a
   * device with no API key runs on, which captures far less but loses nothing
   * and says out loud that it is the one answering.
   *
   * The raw reply that failed is carried through unchanged: the audit trail has
   * to show what the model actually said, not what we did about it.
   */
  function giveUp(
    input: InterpretInput,
    state: CallState,
    issues: string[],
    raw: string | null,
  ): Result<Interpretation> {
    const details = { details: { issues, raw } };
    if (!offlineFallback) {
      return fail('upstream', SCHEMA_GIVE_UP_MESSAGE, details);
    }
    try {
      const response = fallbackInterpret(input.transcript);
      logger?.warn('llm reply unusable; answering offline', { issues: issues.slice(0, 5) });
      return ok({
        response,
        raw: raw ?? '',
        // The calls were real and their tokens were spent, so the meter and the
        // audit row still name the model that failed to produce a reply.
        model: state.model ?? provider.model,
        latencyMs: state.latencyMs,
        attempts: state.attempts,
        calls: state.calls,
        degraded: true,
        issues,
        ...(state.usage ? { usage: state.usage } : {}),
      });
    } catch (error) {
      // `fallbackInterpret` parses its own output, and a device whose clock is
      // decades out can fail that. Nothing left to try; say so.
      logger?.error('offline fallback failed too', { error });
      return fail('upstream', SCHEMA_GIVE_UP_MESSAGE, details);
    }
  }

  /**
   * The tools this turn may use, or `null` for all of them.
   *
   * Two guards sit in front of the picker, and both are about what the picker
   * can actually see:
   *
   *  - **Only a self-contained utterance.** With history, the transcript is an
   *    answer — "the one on Friday", "make it 3pm" — and reading a domain off
   *    it means reading it off a fragment whose subject is in the previous
   *    turn. "3pm" looks exactly like a calendar utterance whichever tool the
   *    parked action belonged to.
   *  - **Only when the caller wants it.** `narrowTools: false` returns the old
   *    behaviour exactly, which is what makes the change measurable.
   */
  function narrowingFor(input: InterpretInput): readonly ToolName[] | null {
    if (options.narrowTools === false) return null;
    if ((input.history?.length ?? 0) > 0) return null;
    const pick = pickTools(input.transcript);
    if (pick.tools === null) {
      logger?.debug('offering every tool', { reason: pick.reason });
      return null;
    }
    logger?.debug('narrowed the tool set', { domains: pick.domains, tools: pick.tools.length });
    return pick.tools;
  }

  return {
    provider,
    isConfigured: () => provider.isConfigured(),
    interpret,
  };
}

export const SCHEMA_GIVE_UP_MESSAGE =
  "I couldn't make sense of the assistant's reply. Please try saying that again.";

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
