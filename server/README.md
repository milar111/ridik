# The assistant backend

The endpoint a **store build** sends every turn to. Your own builds never touch
it: they read a Gemini key from the device keychain and call the provider
directly.

It is server code that happens to live in this repo — excluded from
`tsconfig.json`, and covered by its own jest project (`npm test` runs it).

## Why the app cannot just call the model directly

Three reasons, and only the first is about money:

1. **A key in the app is not your key.** Anything shipped in a bundle can be
   pulled out of it. There is no obfuscation that survives a determined person
   with a copy of your APK.
2. **A free tier is per project, not per user.** Ten users share one bucket; a
   hundred and the app is broken for all of them.
3. **The free tier's data terms.** Google may use free-tier traffic to improve
   its products. Fine for your own notes, not for a paying customer's.

## What is here

| File | What it is |
| --- | --- |
| `interpret.ts` | The handler. `POST /v1/interpret`, a plain `fetch` function. |
| `revenuecat.ts` | `verifyCaller`, asking RevenueCat who has paid. |
| `quota.ts` | The counter: in-memory, Postgres, or Redis. |
| `__tests__/` | 43 tests. The key never leaking is the first thing asserted. |

It talks to **Gemini**, the same provider and the same model family the app calls
directly, because that is the key you hold and the token price every number in
`src/services/billing/allowance.ts` was solved against. It used to POST to
OpenAI, which would have meant buying a second provider and re-deriving the plans
to match — discovered at deployment.

## Wiring it up

```ts
import { createInterpretHandler } from './interpret';
import { createRevenueCatVerifier } from './revenuecat';
import { createPostgresQuota, QUOTA_SCHEMA } from './quota';

const handle = createInterpretHandler({
  apiKey: env.GEMINI_API_KEY,
  verifyCaller: createRevenueCatVerifier({
    secretKey: env.REVENUECAT_SECRET_KEY,     // sk_… — Project settings → API keys
    entitlementId: 'pro',                     // must match EXPO_PUBLIC_REVENUECAT_ENTITLEMENT
    dailyLimits: { ridik_monthly: 25, ridik_yearly: 25, pro_monthly: 100, pro_yearly: 100 },
    fallbackDailyLimit: 25,
  }),
  quota: createPostgresQuota(sql),            // run QUOTA_SCHEMA once
});
```

Then point the app at it: `EXPO_PUBLIC_RIDIK_API_URL=https://your-host` and
rebuild. Nothing else in the app changes — same prompt, same validation, same
repair loop.

## Where it runs

The handler is a plain `fetch` function, so:

- **Cloudflare Workers / Deno Deploy** — `export default { fetch: handle }`
- **Supabase Edge Functions** — `Deno.serve(handle)`
- **Vercel** — re-export as `POST` from `app/api/v1/interpret/route.ts`

Put `GEMINI_API_KEY` and `REVENUECAT_SECRET_KEY` in the platform's secret store.
Neither may appear in the repo, in the client, or in a response body — the handler
swallows upstream error bodies for exactly that reason, and a test asserts it.

## Two things to understand before you rely on it

**The token is an identifier, not a credential.** The app sends its RevenueCat
app user id (`$RCAnonymousID:…`, ~128 bits, unguessable). Anyone who *learns* one
can spend that person's daily allowance — nothing more, since the request body is
their own sentence. The honest fix is a signed token, which needs an account
system, and "no account, nothing to sign in to" is a promise on the consent
screen. That is the trade, made deliberately. What is never trusted is the
*entitlement*: the server asks RevenueCat with its own secret key rather than
believing a claim from the client.

**`increment` must be atomic.** Two requests from one person landing on two
serverless instances in the same millisecond must add two, not one. The Postgres
adapter does the addition inside a single `on conflict do update`; Redis uses
`INCR`. A `select` → `+1` → `update` in application code loses requests under
exactly the load where it matters, which is why neither adapter does one. The
in-memory adapter is for tests and your laptop only — every instance would keep
its own count.

## The window is a UTC day

Not the user's local day. A device clock is something the user can set, and this
counter is the one they cannot edit. `src/services/billing/allowance.ts` says the
same thing about the in-app meter, which ratchets for the same reason.
