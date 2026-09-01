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
| `events.ts` | The usage ingest. `POST /v1/events`, and mostly a list of refusals. |
| `__tests__/` | 56 tests. The key never leaking is the first thing asserted; the second is that the ingest cannot store a sentence. |

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


## The usage ingest, and why it has no authentication

`POST /v1/events` takes the batch the app's Usage screen shows, and it is the
other half of a claim `docs/privacy.md` makes: that the counters carry no
identity. The app can be read to see what it sends. Without this file, "and the
server keeps nothing else" was a promise about code that was not here.

It takes no token, on purpose. `interpret.ts` needs one because it spends the
operator's money; this spends nothing, and a token would be the one thing the
payload is guaranteed not to contain — an identifier. The price is that the
endpoint is spammable, which is what the optional `Sink.rateLimit` seam is for.
Implement it against a hash of the caller's address that you **do not store**:
a per-IP counter kept beside the events is an identifier joined to behaviour,
which is the whole thing this path avoids.

It re-validates every event rather than trusting the client, because a server
that trusts its client has client-side privacy properties. An event is accepted
only if it has exactly the three expected fields, a name from the vocabulary, a
`local_date` that is a date and not a timestamp, and props whose values are all
numbers, booleans, or short single tokens. A string with a space in it is not a
vocabulary value and is dropped — `__tests__/events.test.ts` posts
*"the doctor said the results were"* and asserts it never reaches the sink.

A partial batch returns `202` with a count rather than an error: a client one
version ahead of this server would otherwise retry the same rows for ever.
