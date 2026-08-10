/**
 * The provider used by builds you put in a store.
 *
 * A shipped app cannot carry a model key: anyone can pull it out of the bundle
 * and spend your money, and a single free-tier project is rate-limited across
 * *all* your users at once. So store builds send the request to a backend you
 * own, which holds the key, checks the subscription, and enforces a per-user
 * quota. Only that backend ever sees a provider credential.
 *
 * Nothing above this file changes. The prompt, the Zod validation, the repair
 * loop and the executor are identical whether the tokens came from Gemini
 * directly or from your server — which is the whole point of the seam.
 *
 * The wire format is deliberately the same shape as `LlmRequest`, so the
 * backend is a thin translator to whichever provider you buy from and can be
 * swapped without shipping an app update.
 */
import { LlmProviderError, type LlmCompletion, type LlmProvider, type LlmRequest } from './types';

export type HostedProviderOptions = {
  /** Base URL of your backend, e.g. https://api.ridik.app */
  endpoint: string;
  /**
   * The caller's identity. Resolved per request rather than captured once, so
   * a token that refreshes mid-session is picked up without rebuilding.
   * Returning null means "not signed in" — the provider reports itself
   * unconfigured rather than sending an anonymous request your server will
   * only reject.
   */
  getToken: () => Promise<string | null> | string | null;
  /** Advisory only; the backend decides what it actually runs. */
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type HostedResponse = {
  text?: string;
  model?: string;
  usage?: { input?: number; output?: number };
  error?: { message?: string; code?: string };
  /** Seconds until the caller's quota window resets, when it is exhausted. */
  retryAfterSeconds?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

export function createHostedProvider(options: HostedProviderOptions): LlmProvider {
  const base = options.endpoint.replace(/\/+$/, '');
  const url = `${base}/v1/interpret`;
  const doFetch: typeof fetch = (input, init) => (options.fetchImpl ?? globalThis.fetch)(input, init);

  let lastToken: string | null = null;

  return {
    name: 'hosted',
    model: options.model ?? 'hosted',

    // Optimistic: a token we have not fetched yet is not the same as no
    // account, and reporting unconfigured here would silently drop the user
    // into offline mode on the first turn after a cold start.
    isConfigured: () => Boolean(base) && lastToken !== '',

    async complete(req: LlmRequest): Promise<LlmCompletion> {
      const token = (await options.getToken()) ?? '';
      lastToken = token;
      if (!token) {
        throw new LlmProviderError(
          'unauthorized',
          'Sign in to use the assistant.',
          { status: 401 },
        );
      }

      const started = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      // Honour the caller's cancellation as well as our own deadline.
      const onAbort = () => controller.abort();
      req.signal?.addEventListener('abort', onAbort);

      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            system: req.system,
            messages: req.messages,
            responseSchema: req.responseSchema,
            temperature: req.temperature,
            maxOutputTokens: req.maxOutputTokens,
            ...(options.model ? { model: options.model } : {}),
          }),
          signal: controller.signal,
        });
      } catch (error) {
        const aborted = req.signal?.aborted === true;
        throw new LlmProviderError(
          'network',
          aborted ? 'Cancelled.' : 'Could not reach the assistant.',
          { cause: error },
        );
      } finally {
        clearTimeout(timeout);
        req.signal?.removeEventListener('abort', onAbort);
      }

      const payload = await safeJson(response);

      if (!response.ok) {
        throw errorFor(response.status, payload);
      }

      const text = payload?.text ?? '';
      if (!text.trim()) {
        throw new LlmProviderError('server', 'The assistant returned nothing.', {
          status: response.status,
        });
      }

      return {
        text,
        model: payload?.model ?? options.model ?? 'hosted',
        ...(payload?.usage ? { usage: payload.usage } : {}),
        latencyMs: Date.now() - started,
      };
    },
  };
}

async function safeJson(response: Response): Promise<HostedResponse | null> {
  try {
    return (await response.json()) as HostedResponse;
  } catch {
    return null;
  }
}

function errorFor(status: number, payload: HostedResponse | null): LlmProviderError {
  const detail = payload?.error?.message;

  // 402 is the one status a proxy has that a model API does not: the request
  // was well-formed and authenticated, the subscription just is not current.
  if (status === 402) {
    return new LlmProviderError(
      'unauthorized',
      detail ?? 'Your subscription is not active. Ridik still works offline.',
      { status },
    );
  }
  if (status === 401 || status === 403) {
    return new LlmProviderError('unauthorized', detail ?? 'Sign in again to use the assistant.', {
      status,
    });
  }
  if (status === 429) {
    const wait = payload?.retryAfterSeconds;
    return new LlmProviderError(
      'rate_limited',
      detail ??
        (wait
          ? `You have used this period's assistant requests. Try again in ${Math.ceil(wait / 60)} minutes.`
          : "You have used this period's assistant requests."),
      { status },
    );
  }
  if (status >= 500) {
    return new LlmProviderError('server', detail ?? 'The assistant is having trouble.', { status });
  }
  if (status === 400) {
    return new LlmProviderError('bad_request', detail ?? 'The assistant rejected that request.', {
      status,
    });
  }
  return new LlmProviderError('unknown', detail ?? `Assistant error ${status}.`, { status });
}
