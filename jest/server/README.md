# The assistant backend

`interpret.ts` is a **reference implementation, not a deployed service.** It is
here so the shipping path is concrete rather than a paragraph of advice, and so
the app's `hosted` provider has something real to point at.

It is excluded from the app's typecheck and test runs — it is server code that
happens to live in the same repo.

## Why the app cannot just call the model directly

Three reasons, and only the first is about money:

1. **A key in the app is not your key.** Anything shipped in a bundle can be
   pulled out of it. There is no obfuscation that survives a determined person
   with a copy of your IPA.
2. **A free tier is per project, not per user.** Gemini's 1,500 requests/day is
   shared across everyone running your app. Ten users and you are rate-limited;
   a hundred and the app is broken for all of them.
3. **The free tier's data terms.** Google may use free-tier traffic to improve
   its products. That is fine for your own notes and not fine for a paying
   customer's.

So: your builds use a personal key on the device and your own free tier. Store
builds set `EXPO_PUBLIC_RIDIK_API_URL` and route through here. Same codebase,
same prompt, same validation — only where the tokens come from changes.

## What you have to supply

Two seams, both deliberately unopinionated:

```ts
verifyCaller(token) -> { userId, subscriptionActive, dailyLimit } | null
quota.used(userId) / quota.increment(userId, tokens)
```

**Identity and subscription.** The usual answer is
[RevenueCat](https://www.revenuecat.com/), which wraps App Store and Play
Billing behind one API and will tell you whether an app-user-id is entitled
right now. Verify its webhook signature or call its REST API; do not trust a
claim the client sends. Supabase Auth plus a `subscriptions` table works equally
well if you already run Supabase.

**The counter.** Anything atomic. Redis `INCR` with a TTL to the next UTC
midnight is the obvious one; a Postgres row with `ON CONFLICT DO UPDATE` is
fine at this scale and one less service to run.

## Deploying it

The handler is a plain `fetch` function, so:

- **Cloudflare Workers / Deno Deploy** — `export default { fetch: handle }`.
- **Supabase Edge Functions** — `Deno.serve(handle)`.
- **Vercel** — re-export it from `app/api/v1/interpret/route.ts` as `POST`.

Set `OPENAI_API_KEY` (or your provider's) in the platform's secret store. It must
never appear in the repo, in the client, or in a response body — the handler
deliberately swallows upstream error bodies for exactly this reason.

## The economics

GPT-5.6 Luna at $0.10/$0.60 per million tokens, with a Ridik turn costing roughly
2,500 input and 300 output tokens:

| | requests/month | cost/user/month |
| --- | --- | --- |
| Light user (10/day) | 300 | ~$0.13 |
| Typical user (30/day) | 900 | ~$0.39 |
| Heavy user (100/day) | 3,000 | ~$1.29 |

At €4.99/month that is a 92% gross margin on a typical user and still 74% on a
heavy one. The `dailyLimit` on `Caller` is what stops a pathological user — or a
stolen token — from inverting that. Start it at 150/day; almost nobody speaks to
an app more than that, and the ones who do are your best users, not your problem.

**Prompt caching is the biggest remaining lever.** Ridik's system prompt is large
and almost entirely static, which is precisely the shape caching rewards — the
GPT-5.x family discounts cached input by up to 90%. Adding a cache breakpoint
after the static preamble would cut the input side of the bill by roughly an
order of magnitude. Not implemented here; worth doing before you have many users.

## Before this is production

- Rate-limit by IP as well as by user; a stolen token is otherwise unbounded
  until you notice.
- Log request counts per user, not request contents. The bodies are somebody's
  private notes and there is no reason for your server to keep them.
- Return `Retry-After` alongside the 429 body so infrastructure between you and
  the phone behaves.
- Add a kill switch — an env var that makes every request 503 — so you can stop
  the spend without a deploy.
