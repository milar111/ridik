/**
 * The provider seam.
 *
 * Everything above this line — prompt building, retries, Zod validation — is
 * provider-agnostic, so an on-device model (Apple Intelligence, Gemini Nano)
 * can be dropped in later by implementing `LlmProvider` and nothing else.
 *
 * Providers speak Gemini's two roles ('user' / 'model') because that is the
 * smallest common denominator: every other API can collapse into it.
 */

export type LlmMessage = {
  role: 'user' | 'model';
  content: string;
};

export type LlmRequest = {
  system: string;
  messages: LlmMessage[];
  /** Provider-specific structured-output schema; ignored by providers without one. */
  responseSchema?: unknown;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
};

export type LlmUsage = {
  input?: number;
  /**
   * How many of `input`'s tokens the provider served from a prompt cache.
   *
   * A *subset* of `input`, never an addition to it: both Gemini
   * (`cachedContentTokenCount` inside `promptTokenCount`) and OpenAI
   * (`prompt_tokens_details.cached_tokens` inside `prompt_tokens`) count a
   * cached token in the total and then tell you separately that it was cheap.
   * Undefined means the provider said nothing, which is not the same as zero —
   * a provider with no caching at all never reports the field.
   */
  cached?: number;
  output?: number;
};

export type LlmCompletion = {
  text: string;
  model: string;
  usage?: LlmUsage;
  latencyMs: number;
};

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** False when the provider is missing credentials and would fail every call. */
  isConfigured(): boolean;
  complete(req: LlmRequest): Promise<LlmCompletion>;
}

export type LlmErrorCode =
  | 'rate_limited'
  | 'unauthorized'
  | 'network'
  | 'server'
  | 'bad_request'
  | 'unknown';

/** Codes worth a second attempt; everything else fails the same way twice. */
const RETRYABLE_CODES: ReadonlySet<LlmErrorCode> = new Set<LlmErrorCode>([
  'rate_limited',
  'network',
  'server',
]);

export class LlmProviderError extends Error {
  readonly code: LlmErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    code: LlmErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'LlmProviderError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function isLlmProviderError(error: unknown): error is LlmProviderError {
  return error instanceof LlmProviderError;
}

/** HTTP status to error code. Shared by every REST-backed provider. */
export function llmErrorFromHttpStatus(status: number, message: string): LlmProviderError {
  const code: LlmErrorCode =
    status === 429
      ? 'rate_limited'
      : status === 401 || status === 403
        ? 'unauthorized'
        : status === 408
          ? 'network'
          : status >= 500
            ? 'server'
            : status >= 400
              ? 'bad_request'
              : 'unknown';
  return new LlmProviderError(code, message, { status });
}
