/**
 * Reference backend for store builds. NOT DEPLOYED — this is a starting point.
 *
 * One endpoint, POST /v1/interpret. It exists for three reasons, in order of
 * importance:
 *
 *   1. The model key stays here. A key shipped inside the app is extractable
 *      from the bundle by anyone who downloads it, and then it is their key.
 *   2. The quota is enforced somewhere the user cannot edit. The in-app cap is
 *      a courtesy to the owner of the phone; this is the one that protects the
 *      business.
 *   3. Subscription state is checked per request, so a lapsed subscriber stops
 *      costing money at the next utterance rather than the next release.
 *
 * Written as a plain `fetch` handler so it runs unmodified on Cloudflare
 * Workers, Deno Deploy and Supabase Edge Functions, and with a two-line wrapper
 * on Vercel or anything Node.
 *
 * What is deliberately left to you: how identity is established (`verifyCaller`)
 * and where the counter lives (`Quota`). Both are one-function seams. Wire them
 * to whatever you already have — RevenueCat, Supabase, Stripe — rather than
 * adopting a stack because a reference file suggested it.
 */

/* -------------------------------------------------------------- the seams -- */

export type Caller = {
  /** Stable per person, not per device. */
  userId: string;
  /** False turns every request into a 402 without touching the provider. */
  subscriptionActive: boolean;
  /** Requests allowed per rolling day for this person's plan. */
  dailyLimit: number;
};

export interface Quota {
  /** Requests this caller has already made in the current window. */
  used(userId: string): Promise<number>;
  increment(userId: string, tokens: { input: number; output: number }): Promise<void>;
}

export type Deps = {
  verifyCaller(token: string): Promise<Caller | null>;
  quota: Quota;
  /** Provider key. Read from the environment; never from the request. */
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
};

/* ------------------------------------------------------------- the handler -- */

const DEFAULT_MODEL = 'gpt-5.6-luna';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/** Refuse absurd prompts before they cost anything. */
const MAX_SYSTEM_CHARS = 40_000;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_MESSAGES = 12;

export function createInterpretHandler(deps: Deps) {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;

  return async function handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json(405, { error: { message: 'Use POST.' } });

    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return json(401, { error: { message: 'Missing token.' } });

    const caller = await deps.verifyCaller(token).catch(() => null);
    if (!caller) return json(401, { error: { message: 'Sign in again.' } });

    if (!caller.subscriptionActive) {
      // 402 rather than 403: the app shows a specific, honest message for this
      // and keeps every offline feature working.
      return json(402, {
        error: { message: 'Your subscription is not active. Ridik still works offline.' },
      });
    }

    const used = await deps.quota.used(caller.userId);
    if (used >= caller.dailyLimit) {
      return json(429, {
        error: { message: "You've used today's assistant requests." },
        retryAfterSeconds: secondsUntilUtcMidnight(),
      });
    }

    let body: {
      system?: unknown;
      messages?: unknown;
      responseSchema?: unknown;
      temperature?: unknown;
      maxOutputTokens?: unknown;
    };
    try {
      body = await request.json();
    } catch {
      return json(400, { error: { message: 'Body must be JSON.' } });
    }

    const invalid = validate(body);
    if (invalid) return json(400, { error: { message: invalid } });

    const messages = (body.messages as { role: string; content: string }[]).map((m) => ({
      // The app speaks Gemini's two roles; OpenAI wants 'assistant'.
      role: m.role === 'model' ? 'assistant' : 'user',
      content: m.content,
    }));

    let upstream: Response;
    try {
      upstream = await doFetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify({
          model: deps.model ?? DEFAULT_MODEL,
          messages: [{ role: 'system', content: body.system }, ...messages],
          // The app's whole contract depends on getting parseable JSON back.
          response_format: { type: 'json_object' },
          temperature: typeof body.temperature === 'number' ? body.temperature : 0.1,
          ...(typeof body.maxOutputTokens === 'number'
            ? { max_completion_tokens: body.maxOutputTokens }
            : {}),
        }),
      });
    } catch {
      return json(502, { error: { message: 'The assistant is unreachable.' } });
    }

    if (!upstream.ok) {
      // Never forward the provider's body: it can name the account and the key.
      const retryable = upstream.status === 429 || upstream.status >= 500;
      return json(retryable ? 503 : 502, {
        error: { message: 'The assistant is having trouble.' },
      });
    }

    const payload = (await upstream.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
      model?: string;
    } | null;

    const text = payload?.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) return json(502, { error: { message: 'The assistant returned nothing.' } });

    const input = payload?.usage?.prompt_tokens ?? 0;
    const output = payload?.usage?.completion_tokens ?? 0;
    // Part of `input`, not extra: what the provider served from its prompt
    // cache. Forwarded because this is the one place caching can pay — the
    // static half of Ridik's system prompt is identical for every user of this
    // proxy, so one warm prefix serves the fleet — and the app cannot tell
    // whether that is happening unless the number comes back with the answer.
    const cached = payload?.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    // Counted after success: a failed call the user never got an answer from
    // should not consume their allowance.
    await deps.quota.increment(caller.userId, { input, output }).catch(() => {});

    return json(200, {
      text,
      model: payload?.model ?? deps.model ?? DEFAULT_MODEL,
      usage: { input, cached, output },
    });
  };
}

function validate(body: {
  system?: unknown;
  messages?: unknown;
}): string | null {
  if (typeof body.system !== 'string' || body.system.length === 0) return 'system is required.';
  if (body.system.length > MAX_SYSTEM_CHARS) return 'system prompt is too large.';
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages are required.';
  if (body.messages.length > MAX_MESSAGES) return 'too many messages.';
  for (const message of body.messages as unknown[]) {
    const m = message as { role?: unknown; content?: unknown };
    if (m.role !== 'user' && m.role !== 'model') return 'each message needs a valid role.';
    if (typeof m.content !== 'string' || m.content.length === 0) return 'each message needs content.';
    if (m.content.length > MAX_MESSAGE_CHARS) return 'a message is too long.';
  }
  return null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function secondsUntilUtcMidnight(at = new Date()): number {
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return Math.max(1, Math.round((midnight - at.getTime()) / 1000));
}
