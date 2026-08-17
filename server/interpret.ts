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

/*
 * Gemini, and specifically the same model the app calls directly.
 *
 * This file used to POST to OpenAI, which was a quiet trap: every price in
 * `src/services/billing/allowance.ts` was solved against Flash-Lite token rates,
 * the key the operator actually holds is a Gemini key, and the pinned model in
 * `src/llm/provider/gemini.ts` carries a comment explaining that moving up the
 * Flash family alone turns the upper tier from $1.93 to $10.58 of cost against
 * $7.60 of revenue. Deploying an OpenAI-shaped proxy would have meant buying a
 * second provider and re-deriving the plans to match it, discovered at the point
 * of deployment.
 *
 * Keep this in step with `DEFAULT_GEMINI_MODEL`. The two are allowed to differ —
 * the backend is exactly the seam that lets the operator move models without
 * shipping an app update — but they should differ on purpose.
 */
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

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

    /* The app already speaks Gemini's roles — `user` and `model` — so this is a
       shape change rather than a translation. */
    const contents = (body.messages as { role: string; content: string }[]).map((m) => ({
      role: m.role === 'model' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const model = deps.model ?? DEFAULT_MODEL;
    let upstream: Response;
    try {
      upstream = await doFetch(`${GEMINI_BASE_URL}/models/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // In a header, not the query string: query strings end up in proxy and
          // CDN logs, and this is the operator's key rather than the user's.
          'x-goog-api-key': deps.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: body.system }] },
          contents,
          generationConfig: {
            temperature: typeof body.temperature === 'number' ? body.temperature : 0.1,
            ...(typeof body.maxOutputTokens === 'number'
              ? { maxOutputTokens: body.maxOutputTokens }
              : {}),
            /*
             * JSON is asked for, a schema is deliberately NOT sent.
             *
             * `settings.ts` records the measurement: eight representative
             * utterances against the live API put rung 0 (a full schema) at HTTP
             * 400 on every request and rung 1 (an envelope) at 7 of 8 turns
             * answered with an empty `parameters: {}`. Rung 2 — prose
             * instructions, `responseMimeType` only — was 8 of 8, at 1.13 calls
             * per request instead of 2.88 and 2,932 input tokens instead of
             * 9,103. The client forwards `responseSchema` for a provider that
             * wants one; this one is measurably worse with it.
             */
            responseMimeType: 'application/json',
          },
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
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        cachedContentTokenCount?: number;
      };
      modelVersion?: string;
    } | null;

    /* Gemini splits a reply across parts whenever it feels like it; joining is
       not optional, and taking parts[0] silently truncates long answers. */
    const text = (payload?.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part?.text ?? '')
      .join('');
    if (!text.trim()) return json(502, { error: { message: 'The assistant returned nothing.' } });

    const input = payload?.usageMetadata?.promptTokenCount ?? 0;
    /* Thinking tokens are billed as output and are NOT in `candidatesTokenCount`,
       which counts only the visible reply. Omitting them undercounts the quota
       against exactly the turns that cost most — `gemini.ts` sums them the same
       way for the same reason. */
    const output =
      (payload?.usageMetadata?.candidatesTokenCount ?? 0) +
      (payload?.usageMetadata?.thoughtsTokenCount ?? 0);
    // Part of `input`, not extra: what the provider served from its prompt
    // cache. Forwarded because this is the one place caching can pay — the
    // static half of Ridik's system prompt is identical for every user of this
    // proxy, so one warm prefix serves the fleet — and the app cannot tell
    // whether that is happening unless the number comes back with the answer.
    const cached = payload?.usageMetadata?.cachedContentTokenCount ?? 0;
    // Counted after success: a failed call the user never got an answer from
    // should not consume their allowance.
    await deps.quota.increment(caller.userId, { input, output }).catch(() => {});

    return json(200, {
      text,
      /* What actually answered, not what was asked for. `gemini-flash-latest`
         resolved to `gemini-3.7-flash` the first time a real key was used, at
         five times the input price the plans assumed — a proxy that reports the
         requested model hides exactly that. */
      model: payload?.modelVersion ?? model,
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
