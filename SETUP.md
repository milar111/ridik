# Setup, costs, and what is actually finished

Everything you need to get Ridik running for real, plus straight answers on the
model choice, the iOS gaps, and whether this is safe to put in front of people.

---

## 1. What you need to supply

The app runs **fully offline with nothing configured** — notes, tasks, projects,
lists, habits, ledger, calendar, timers and the briefing all work on-device.
Only the two networked features need keys.

There are **two deployment shapes** and they need different things.

**Your own builds** (what you run day to day): a personal Gemini key on the
device, your free tier, nothing to pay and nothing to host.

**Store builds** (what you sell): a backend you own holds the key and checks the
subscription. Users supply nothing. See §2b.

| Thing | Needed for | Where it goes | Cost |
| --- | --- | --- | --- |
| **Gemini API key** | Your own builds only | Settings → Voice → Assistant API key | Free tier is almost certainly enough |
| **`EXPO_PUBLIC_RIDIK_API_URL`** | Store builds | Build-time env var | — |
| **A provider key on the server** | Store builds | Your backend's secret store | ~$0.39/user/month |
| **Google OAuth client ids** | Google Calendar sync | Build-time env vars | Free |
| **OpenAI key** *(optional)* | Whisper fallback in noisy rooms | Settings → Voice → Whisper API key | ~$0.006/min, rarely used |
| **Supabase** | Optional — see §5 | — | — |

**Speech-to-text costs nothing and needs no key.** It uses the phone's own
recogniser — `SFSpeechRecognizer` on iOS, `SpeechRecognizer` on Android — and
asks for on-device recognition wherever the locale supports it
(`src/voice/stt.ts` checks `supportsOnDeviceRecognition()` before each request).
Audio never leaves the phone on that path. The Whisper fallback is opt-in,
needs its own key, and only fires for the specific failures a re-listen could
fix, so in practice it is close to never used. That keeps the per-utterance cost
to the language model alone.

### Gemini key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and create a key.
2. Paste it into **Settings → Voice → Assistant API key**.

It is stored in the iOS Keychain / Android Keystore via `expo-secure-store`, never
in the database and never in a file in the repo. Without it the app falls back to
pattern matching, which handles "spent 12 on lunch" and short notes but not dates,
dependencies or multi-intent sentences.

### Google Calendar

Create an OAuth 2.0 client per platform in the
[Google Cloud console](https://console.cloud.google.com/apis/credentials), enable
the **Google Calendar API**, then set these before building:

```bash
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=…apps.googleusercontent.com
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=…apps.googleusercontent.com
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=…apps.googleusercontent.com
```

The iOS client needs the URL scheme (reversed client id) registered; the Android
client needs your debug and release SHA-1 fingerprints. Until this is set,
Settings shows "Google sign-in is not configured in this build" and events stay
on the device — which is a complete, working state, not a broken one.

**The phone's own calendar** (Apple Calendar / Samsung Calendar) needs no keys at
all — just the permission. Ridik creates its own local calendar and mirrors into it.

---

## 2. Which model — Gemini, GPT, or Ollama?

**Short answer: Gemini Flash. It's already the default, and the free tier likely
covers you entirely.**

The workload is narrow and unglamorous: ~2,500 input tokens (system prompt +
your injected context) → ~300 output tokens of strict JSON, and it has to come
back fast enough that speaking feels instant. That profile rewards a cheap, fast
model with native structured output, not a reasoning flagship.

### The numbers

Per utterance, at published August 2026 list prices:

| Model | Input / output per 1M | Cost per utterance | 50/day |
| --- | --- | --- | --- |
| **Gemini free tier** | — | **$0** (1,500 req/day) | **$0** |
| Gemini 3 Flash | $0.25 / $1.50 | ~$0.0011 | ~$1.65/mo |
| Gemini 3.1 Flash-Lite | $0.10 / $0.40 | ~$0.0004 | ~$0.60/mo |
| GPT-5.6 Luna | $0.10 / $0.60 | ~$0.0004 | ~$0.65/mo |
| Gemini 3.6 Flash | $1.50 / $7.50 | ~$0.0060 | ~$9/mo |
| GPT-5.6 Terra | $2.00 / $12.00 | ~$0.0086 | ~$13/mo |

At realistic personal usage (30–60 utterances a day) the **free tier's 1,500
requests/day is 25–50× more headroom than you need.** You will most likely never
pay anything.

### Why Gemini over GPT here

- **A real free tier.** OpenAI has none. For a single-user personal app that is
  the whole argument.
- **Native structured output.** `responseMimeType: 'application/json'` plus a
  response schema — the app already uses it. Fewer malformed replies means fewer
  repair round-trips, which is both cheaper and faster.
- **Latency.** Flash-class models return in a few hundred ms; you feel this on
  every single utterance.

GPT-5.6 Luna is a genuinely good alternative and priced comparably. It is worth
having as a fallback if Gemini's quality on multi-intent parsing disappoints you —
the provider layer (`src/llm/provider/`) exists precisely so you can add one file
and switch. It is not worth switching to by default.

### Why not Ollama

Ollama is a **desktop server**, not a mobile runtime. Two ways to use it, both bad
here:

1. **Run it on your PC and point the phone at it.** Then the app only understands
   you at home, on your LAN or through a VPN. That's a worse offline story than
   what you have now, not a better one.
2. **Run a model actually on the phone** (llama.cpp / MLC). Feasible in 2026, but
   you get 1–3B models at ~3–5 tokens/sec. A 300-token JSON reply takes over a
   minute, and small models are exactly the ones that fumble strict schemas and
   multi-intent parsing. It would make the headline feature unusable.

### The genuinely interesting third option: Apple Foundation Models

iOS 26 ships an on-device LLM that any app can call, and
[`@react-native-ai/apple`](https://www.react-native-ai.dev/) makes it reachable
from JavaScript. **Free, private, zero network, no key.**

The catch is a **4K token context budget**, and Ridik's prompt injects your
timetable, agenda, tasks, projects, notes and people — it will not fit as-is.
The realistic shape is a two-tier router: simple utterances ("log 45 minutes of
workout", "add milk to groceries") handled on-device with a trimmed prompt,
anything with dates, dependencies or several intents escalated to Gemini. That
would drop cloud calls by maybe 70% and make most of the app work in airplane
mode. It's a genuinely good idea and it is **not built** — it's the single most
worthwhile follow-up on this list.

**Recommendation: stay on Gemini Flash. Add the Apple tier later if you want the
privacy and offline win; it is an addition, not a migration.**

---

## 2b. Shipping it: your free tier for you, a proxy for customers

**Built and wired.** `app.config.ts` exposes `EXPO_PUBLIC_RIDIK_API_URL`. When it
is set, the app routes every assistant request through that backend with the
user's session token and never touches a model key. When it is unset — your
builds — it reads a personal key from the keychain and calls Gemini directly on
your free tier. Same prompt, same validation, same executor; only the transport
differs (`src/llm/provider/hosted.ts`).

You cannot ship your own key inside the app, for three reasons and only the first
is about money:

1. **A key in a bundle is not your key.** Anyone who downloads the app can
   extract it. No obfuscation survives that.
2. **A free tier is per project, not per user.** 1,500 requests/day is shared
   across *everyone* running your app. Ten users and you are rate-limited.
3. **Free-tier data terms.** Google may use free-tier traffic to improve its
   products — fine for your notes, not for a paying customer's.

`server/interpret.ts` is a working reference handler (~200 lines, plain `fetch`,
runs on Cloudflare / Deno / Supabase Edge / Vercel unchanged). It leaves exactly
two seams for you: `verifyCaller(token)` — usually
[RevenueCat](https://www.revenuecat.com/), which wraps App Store and Play Billing
behind one entitlement check — and a `quota` counter, for which Redis `INCR` with
a TTL to midnight or a Postgres upsert both work. `server/README.md` has the
detail.

The economics at Luna's $0.10/$0.60:

| | requests/month | cost/user/month |
| --- | --- | --- |
| Light (10/day) | 300 | ~$0.13 |
| Typical (30/day) | 900 | ~$0.39 |
| Heavy (100/day) | 3,000 | ~$1.29 |

At €4.99/month that is a **92% gross margin on a typical user**, 74% on a heavy
one. The per-user `dailyLimit` is what stops a pathological user or a stolen
token from inverting that — start it at 150/day.

**Prompt caching is the biggest remaining lever.** The system prompt is large and
almost entirely static, exactly the shape caching rewards; the GPT-5.x family
discounts cached input by up to 90%. Adding a cache breakpoint after the static
preamble would cut the input side of the bill by roughly an order of magnitude.
Not implemented — worth doing before you have many users.

---

## 3. Not losing money

Three independent layers, two of which are already live.

### Layer 1 — the app caps itself (built, on by default)

**Settings → Voice → Requests per day / Requests per month**, defaulting to
**200/day and 3,000/month**. The counter lives in a `llm_usage` table, resets on
your local midnight and on the calendar month, and shows you the running cost
estimate. Past the cap the app **does not stop working** — it falls back to
offline pattern matching and tells you once why the answers got simpler.

It counts *requests*, not dollars, deliberately: a request cap is something you
can reason about, and it holds even if Google changes its prices underneath you.

### Layer 2 — Google's hard spend cap (you should set this)

Google shipped real **spend caps** in 2026 that *pause the service* rather than
just emailing you. This is the backstop that survives any bug in my code.

1. [Cloud Billing → Budgets & alerts](https://console.cloud.google.com/billing/budgets)
2. Create a budget scoped to your Gemini project, set the amount (a few dollars
   is plenty), and **enable the spend cap**, not just the alert.

Caveat worth knowing: enforcement is on *estimated* cost and takes a couple of
minutes, so a small overage is possible. It is not a fuse, it is a fast brake.

### Layer 3 — use the free tier

Do not enable billing on the Gemini project at all until you have evidence you
need to. A key with no billing attached simply gets rate-limited at 1,500
requests/day. That is the strongest possible spend cap.

### What the app already does to keep calls cheap

- Context sections are capped before they reach the prompt (20 classes, 12
  events, 15 tasks…), so a busy month cannot silently inflate every request.
- Malformed replies are repaired at most twice, then it gives up with a clear
  message instead of looping.
- Transport retries are limited and use jittered exponential backoff — a 429 or a
  5xx cannot turn into a retry storm.
- A confirmation ("yes, book over it") is applied **without a second model call**.

---

## 4. The iOS gaps — do you have to switch to Swift?

**No. You do not rewrite anything.** Here is each one honestly.

### Live Activities (Dynamic Island / lock-screen timer)

**You need a small amount of Swift, but not a Swift app.**

A Live Activity is a *widget extension* — a separate target in the Xcode project
with its own SwiftUI view. There is no way around that: it renders in
SpringBoard's process, not yours, so it cannot be React. But:

- The extension is maybe 60–100 lines of SwiftUI describing what the lock-screen
  card looks like. Your app stays React Native.
- [`expo-live-activity`](https://github.com/software-mansion-labs/expo-live-activity)
  (Software Mansion) ships a config plugin that **generates the target for you**
  during prebuild, so for a standard "label + countdown + progress bar" card you
  may write no Swift at all. There is also
  [`react-native-widget-extension`](https://github.com/bndkt/react-native-widget-extension)
  and a newer Expo Widgets library.
- `src/services/focus/liveActivity.ts` is already written as a capability-detected
  adapter with the exact upgrade steps in its header comment. Install the package,
  add the plugin, prebuild — `isSupported()` starts returning true and nothing
  else in the app changes.

Until then, iOS gets an ongoing time-sensitive notification on the lock screen
showing the phase and finish time. Android already has the full persistent
notification with live countdown and action buttons.

### The map picker

**No Swift at all.** `react-native-maps` is a normal install with a config plugin.
It was left out because it needs a Google Maps API key on Android and I did not
want to add a key requirement to a feature that works without one. Today it is a
coordinate + radius editor with "use my current location" and reverse geocoding,
which is functional but not nice.

### Home-screen shortcuts

Already built (`expo-quick-actions`) and verified registered with both operating
systems. Long-press the icon → "Speak to Ridik" / "Today's briefing".

### Verdict

Nothing here requires abandoning React Native. The only genuine native work is a
~100-line SwiftUI widget, and there is a config plugin that will probably write
it for you.

---

## 5. Supabase — do you want it?

**It is not used, and for what the app does today it isn't needed.** Ridik is
local-first: SQLite on the device, Google Calendar as the only sync surface.

You would want Supabase (or equivalent) for exactly three things:

1. **Multi-device.** Phone + tablet + web sharing one dataset. Today the only
   thing that syncs is your calendar.
2. **Backup.** Right now, lose the phone and lose the notes. An export exists, but
   it's manual.
3. **Proxying the LLM key.** Calling Gemini from the phone means the key is on the
   phone. For a personal app that's fine. For a shipped app it is not — anyone
   who extracts it spends your money. A tiny Supabase edge function holding the
   key server-side fixes that, and is the cleanest place to enforce per-user
   quotas too.

If you ever ship this to other people, **#3 stops being optional.** The data layer
is already built so this is tractable: `sync_queue` is a generic outbox, and the
repositories are pure and testable — a Supabase adapter would sit next to the
Google Calendar one rather than replacing anything.

**My advice: not yet.** Add it when you want a second device or real users.

---

## 5b. What the stores will actually ask for

Settings is deliberately small — four controls a person can change plus the
things review requires. That is the whole list below; nothing else on the screen
exists to satisfy a guideline.

**Already in the app:**

- **Privacy policy and Terms of use** links in Settings → About. They read their
  URLs from `EXPO_PUBLIC_PRIVACY_URL` / `EXPO_PUBLIC_TERMS_URL` and say plainly
  that no link is set up yet rather than shipping a placeholder that 404s. Set
  both before you submit.
- **Delete all data** (Settings → Your data), gated on typing ERASE. Apple only
  requires account deletion when an app has accounts, but a one-tap wipe is also
  what a GDPR request looks like in practice.
- **Export everything** — the other half of a data-portability request.
- **Permission usage strings** for microphone, speech, calendar and location,
  all written in `app.config.ts`. Review rejects vague ones; these say what the
  app does with the access and why.
- **Permissions requested in context**, not at launch. Asking for four
  permissions on a cold start is both a rejection risk and the reason people
  deny them.
- **`ITSAppUsesNonExemptEncryption: false`** already declared, so the export
  compliance question does not stall every build.

**Still to do before submission:**

- **App Privacy answers in App Store Connect.** Do not write these from memory —
  the sentence that used to be here listed two outbound paths and there are
  nine. `DEPLOY.md` has the per-type table to copy, `notes/STORE-CHECKLIST.md`
  has the same answers beside Play's, and `app.config.ts` → `ios.privacyManifests`
  is the shipped declaration all three must agree with. Every one of them is a
  disclosure, not a problem; a declaration that omits one is the problem.
- **Screenshots, icon and description.** The icon is still the Expo default.
- **A real privacy policy and EULA** at the URLs above.

**Only once you add the subscription:**

- **Restore Purchases** — Apple requires it and will reject without it.
  RevenueCat gives you one call.
- **Terms and Privacy links on the paywall itself**, not just in Settings.
- **Price, duration and renewal terms stated in the app** before purchase.
- **Play Billing** needs the same restore path; Google is less strict about
  placement but not about the disclosure.

---

## 5c. The map picker — what to get before I build it

The address editor in Places works, but you cannot see where the pin landed. A
real map is a small change to one block of `app/places.tsx`; it is the setup
around it that you have to do, because it needs accounts only you can open.

**What I need from you: one Google Maps API key, for Android only.**

iOS needs nothing. `react-native-maps` renders Apple Maps through MapKit on iOS
with no key and no account. Android has no equivalent — without a key the map
view renders as a blank grey grid, which looks exactly like a bug.

To create it:

1. Go to the [Google Cloud console](https://console.cloud.google.com/), make a
   project (or reuse the one holding your Calendar OAuth client — the Calendar
   client ids in `app.config.ts` under `extra.googleOAuth` are a different kind
   of credential and cannot be reused for this).
2. Enable **Maps SDK for Android**. That is the only API the map itself needs.
3. Credentials → Create credentials → API key.
4. **Restrict it before you use it.** Application restriction → Android apps,
   then add the package name `ai.dby.ridik` together with your signing
   certificate's SHA-1 fingerprint. An unrestricted Maps key that reaches a
   public repository gets used by strangers and billed to you.
5. API restriction → limit it to Maps SDK for Android.

Maps SDK for Android has no per-map charge at the volume this app will produce,
but the key still has to sit on a project with billing enabled.

Two things worth knowing before you decide it is worth it:

- **Adding the library needs a native rebuild** of both platforms
  (`npx expo prebuild --clean` and a fresh build), because it ships native code.
  Everything currently installed on your simulators would be replaced.
- **Search will still not offer a "did you mean" list.** `expo-location`'s
  `geocodeAsync` returns coordinates for a string and nothing else — no place
  names, no candidates, no disambiguation. The map fixes *confirming* a pin,
  which is the real problem: you will be able to see that the address resolved
  somewhere sensible before you save it. A proper search-as-you-type list is the
  Google **Places** API, which is separately enabled and genuinely metered.

Send me the key and I will wire it into `app.config.ts`, prebuild both
platforms and build the picker.

## 6. Battle-tested vs production-ready

You are right that these are different questions. Taking them separately.

### Is it production-ready? — **Largely yes, with named exceptions.**

Meaning: does it have the engineering properties something shipped needs?

**Yes:**
- **965 tests across 55 suites**, run against real SQLite through the same
  Drizzle driver that ships, not mocks.
- **Migrations are versioned and append-only**, run in a transaction each,
  proven to apply on both devices.
- **Offline-first throughout.** Every write lands locally first; network work
  goes through a retrying outbox.
- **Errors degrade rather than crash.** Error boundaries per tab, `Result` types
  across feature seams, every native call guarded. A denied permission logs one
  line and the app keeps working — verified on both simulators.
- **Secrets are in the Keychain/Keystore**, never in the database, never in a URL.
- **Spend controls exist and are on by default.**
- The whole thing was reviewed adversarially, which caught real defects —
  background sync silently never running, deleted events left behind on the
  device calendar, travel buffers outliving their events, a DST bug in all-day
  events. Those are fixed with regression tests.

**Not yet:**
- ~~**No crash reporting.**~~ Sentry is wired — `src/services/analytics/crash.ts`,
  behind the same off-by-default switch as the usage counts, with breadcrumbs,
  screenshots, view hierarchy and Sentry's own `user` all disabled. What is
  *not* done: no DSN has ever been set, so it has never sent a report. Put one
  in `EXPO_PUBLIC_SENTRY_DSN`, turn the switch on and crash it once.
- **No release build has ever been made.** Debug only. A release build enables
  Hermes bytecode and ProGuard/R8 — things break there that never break in debug.
- **No app icons or store assets** beyond the Expo defaults.
- **The LLM key lives on the device** (see §5.3).
- **Google Calendar sync has never spoken to Google.** Every path is covered
  against a mocked transport; none has met the real API.

### Is it battle-tested? — **No. Not remotely.**

Battle-tested means it survived contact with reality: real users, bad networks,
low storage, a year of accumulated data, OS upgrades, timezone travel, phones
that die mid-write. This app has existed for a few hours and has never been used
by a human being.

Specifically untested against reality:

- **Real speech.** Simulators have no microphone worth the name. The VAD
  thresholds, the confidence gate, the Whisper fallback — all reasoned about and
  unit-tested, none used in a noisy room.
- **Real LLM output.** Every test uses the mock provider. Gemini will produce
  shapes I did not anticipate. The Zod layer will catch them and the repair loop
  will retry, but the *prompt* will need tuning against real failures.
- **Scale.** Tested with tens of rows. Notes search loads all notes into memory
  to resolve a fuzzy match — fine at 50 notes, not at 5,000.
- **Background execution.** iOS is notoriously stingy about background refresh in
  the field, and the simulator does not model it at all.
- **Battery.** Geofencing is configured conservatively, but nobody has watched a
  battery percentage for a day.

**The honest summary:** the engineering is production-grade; the product is a
prototype that has never met a user. Use it yourself for two weeks and you will
find a dozen things — that is the missing step, and no amount of tests replaces it.

---

## 7. Suggested order of work

1. Use it yourself for a week. Nothing else is as informative — and the Usage
   screen now tells you what that week actually consisted of.
2. Set `EXPO_PUBLIC_SENTRY_DSN` and prove a crash arrives.
3. Make a release build on both platforms and fix whatever breaks.
4. Set the Google spend cap (5 minutes).
5. Tune the prompt against whatever Gemini actually gets wrong for you.
6. The UI — you already said it needs work, and you are right.
7. Live Activities via the config plugin, if the timer matters to you.
8. Apple Foundation Models as a first tier for simple commands.
9. Supabase, only when you want a second device or other users.

---

Sources for the pricing, limits and library claims above:

- [Gemini API rate limits per tier (2026)](https://www.aifreeapi.com/en/posts/gemini-api-rate-limits-per-tier)
- [Gemini API free tier: 1,500 req/day](https://tokenmix.ai/blog/gemini-api-free-tier-limits)
- [Gemini API pricing, August 2026](https://benchlm.ai/google/api-pricing)
- [OpenAI API pricing, August 2026](https://benchlm.ai/openai/api-pricing)
- [Google Cloud spend caps announcement](https://cloud.google.com/blog/topics/cost-management/introducing-spend-caps-ai-cost-visibility-next26)
- [Manage spend cap budgets](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)
- [On-device Apple LLM support in React Native](https://www.callstack.com/blog/on-device-apple-llm-support-comes-to-react-native)
- [expo-live-activity](https://github.com/software-mansion-labs/expo-live-activity)
- [Home screen widgets and Live Activities in Expo](https://expo.dev/blog/home-screen-widgets-and-live-activities-in-expo)
- [Running LLMs locally on Android & iOS](https://nkaushik.in/writing/top-4-ways-to-run-llm-locally-on-android-and-ios/)
