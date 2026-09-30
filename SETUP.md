# Setup

What Ridik needs to run with every feature on, why the model and transport
choices are what they are, and how spend is kept under control. `DEPLOY.md` is
the step-by-step checklist for shipping to the stores.

---

## 1. What you need to supply

The app runs **fully offline with nothing configured** — notes, tasks, projects,
lists, habits, money, calendar, timers and the briefing all work on-device.
Only the networked features need keys.

There are **two deployment shapes** and they need different things.

**Personal builds:** a Gemini API key entered on the device. Nothing to host.

**Store builds:** a backend you run holds the provider key and checks the
subscription. Users supply nothing. See §4.

| Thing | Needed for | Where it goes | Cost |
| --- | --- | --- | --- |
| **Gemini API key** | Personal builds | In-app Developer screen → Assistant key | Free tier, or usage-based |
| **`EXPO_PUBLIC_RIDIK_API_URL`** | Store builds | Build-time env var | — |
| **A provider key on the server** | Store builds | Your backend's secret store | Usage-based |
| **Google OAuth client ids** | Google Calendar sync | Build-time env vars | Free |
| **OpenAI key** *(optional)* | Whisper transcription fallback | In-app Developer screen → Whisper key | ~$0.006/min |
| **AssemblyAI key** *(optional)* | Cloud transcription engine | In-app Developer screen → AssemblyAI key | Usage-based |

The Developer screen is enabled from Settings → Version. Store builds hide the
key fields.

### Speech-to-text

**The default engine costs nothing and needs no key.** It is the phone's own
recogniser — Apple's `SpeechAnalyzer` on iOS 26 where its model is installed,
`SFSpeechRecognizer` otherwise, and `SpeechRecognizer` on Android. On-device
recognition is requested wherever the locale supports it; where it does not,
the platform's speech service processes the audio, which the first-run
disclosure names.

Settings → How it listens offers two alternatives:

- **This phone, more carefully** — whisper.cpp on the device re-reads the
  recording after you stop and replaces the transcript. Nothing is uploaded; it
  needs a one-off model download (~57 MB).
- **AssemblyAI** — appears once a key is set; the recording is uploaded to
  AssemblyAI for transcription.

The Whisper fallback (OpenAI) is opt-in, needs its own key, and only runs when
the platform recogniser fails in a way a re-listen could fix.

### Gemini key

1. Create a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Paste it into the Developer screen → **Assistant key**.

It is stored in the iOS Keychain / Android Keystore via `expo-secure-store`,
never in the database and never in a file in the repo. Without it the app uses
its offline pattern matcher, which handles reminders, spending, list items,
search and plain notes, one action per sentence.

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
client needs your debug and release SHA-1 fingerprints. `DEPLOY.md` §2.3 has the
full walkthrough. Until this is set, Settings shows "Google sign-in is not
configured in this build" and events stay on the device — a complete, working
state.

**The phone's own calendar** (Apple Calendar / Samsung Calendar) needs no keys —
just the permission. Ridik creates its own local calendar and mirrors into it.

---

## 2. The model

**Gemini 3.1 Flash-Lite, pinned** (`DEFAULT_GEMINI_MODEL` in
`src/llm/provider/gemini.ts`).

The workload is narrow: roughly 2,500 input tokens (system prompt plus the
injected context) and about 300 output tokens of strict JSON, returned fast
enough that speaking feels instant. That profile rewards a fast, inexpensive
model with native structured output rather than a reasoning flagship.

- **Native structured output.** `responseMimeType: 'application/json'` plus a
  response schema. Fewer malformed replies means fewer repair round-trips, which
  is both cheaper and faster.
- **Latency.** Flash-class models answer in a few hundred milliseconds, which is
  felt on every utterance.
- **A free tier** for personal builds. See Google's
  [current rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).
- **Cost.** At Flash-Lite list prices ($0.10 input / $0.40 output per 1M tokens,
  [pricing](https://ai.google.dev/gemini-api/docs/pricing)) a typical turn costs
  about $0.0004.

The provider layer (`src/llm/provider/`) is an interface: the tool contract
belongs to the app, not the vendor, so another provider is one file.

### Why the model is not on the phone

A local runtime (llama.cpp / MLC) on a phone runs 1–3B models at a few tokens
per second, so a 300-token JSON reply takes too long for a voice interface, and
small models are the ones that struggle with strict schemas and multi-intent
sentences. Apple's on-device Foundation Model has a 4K-token context, smaller
than Ridik's injected context. The offline pattern matcher covers the no-network
case instead.

---

## 3. Spend controls

Three independent layers.

### Layer 1 — the app caps itself (on by default)

Personal builds default to **200 requests a day and 3,000 a month**, adjustable
on the Developer screen. The counter lives in the `llm_usage` table and resets on
the local day and the calendar month. Past the cap the app **keeps working** — it
falls back to the offline matcher and says so once.

Store builds are governed by `resolveAssistantBudget()`: the subscription's
allowance, or a lifetime free trial on an install with no entitlement. Ceilings
can be stated in requests, tokens or cost, and the first one crossed stops the
turn.

### Layer 2 — Google's spend cap

Google Cloud budgets can **pause the service** at a spend cap rather than only
emailing an alert.

1. [Cloud Billing → Budgets & alerts](https://console.cloud.google.com/billing/budgets)
2. Create a budget scoped to your Gemini project, set the amount, and **enable
   the spend cap**, not just the alert.

Enforcement runs on estimated cost with a short delay, so treat it as a fast
brake rather than a fuse. See
[Manage spend cap budgets](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps).

### Layer 3 — the free tier

A key on a project with no billing attached is rate-limited rather than charged,
which is the strongest cap available for a personal build.

### What keeps each call small

- Context sections are capped before they reach the prompt (20 classes, 12
  events, 15 tasks…), so a busy month cannot inflate every request.
- The system prompt is byte-identical between turns and recent conversation
  travels outside it, so a provider can cache the prefix.
- Malformed replies are repaired at most twice, then the turn ends with a clear
  message.
- Transport retries are limited and use jittered exponential backoff.
- A confirmation ("yes, book over it") is applied **without a second model
  call**.

---

## 4. Store builds: the hosted assistant

`app.config.ts` exposes `EXPO_PUBLIC_RIDIK_API_URL`. When it is set, every
assistant request goes through that backend with the user's RevenueCat app user
id, and the app never holds a model key. When it is unset, the app reads a
personal key from the keychain and calls Gemini directly. Same prompt, same
validation, same executor; only the transport differs
(`src/llm/provider/hosted.ts`).

A provider key cannot ship inside the app:

1. **A key in a bundle can be extracted** by anyone with a copy of the app.
2. **A free tier is per project, not per user**, so every install would share
   one quota.
3. **Free-tier data terms** allow Google to use that traffic to improve its
   products, which is not appropriate for customers' requests.

`server/interpret.ts` is the reference handler — a plain `fetch` function that
runs on Cloudflare Workers, Deno Deploy, Supabase Edge Functions or Vercel. It
verifies the caller's entitlement with RevenueCat's secret key and counts a
per-user daily quota in Postgres or Redis. `server/README.md` has the detail.

---

## 5. Platform features

### Focus timer on the lock screen

Android shows a persistent notification with a live countdown and action
buttons. iOS shows an ongoing time-sensitive notification with the phase and
finish time. `src/services/focus/liveActivity.ts` is a capability-detected
adapter: when a Live Activity module is present, `isSupported()` returns true and
the timer uses it with no other change.

### Places

The place editor takes an address or coordinates, a radius, and a "use my
current location" shortcut, with reverse geocoding through the platform's
geocoder. Arrival is checked on the device.

### Home-screen shortcuts

Registered through `expo-quick-actions` on both platforms: long-press the icon →
"Speak to Ridik" / "Today's briefing".

---

## 6. Data and sync

Ridik is local-first: SQLite on the device, with Google Calendar and the phone's
own calendar as the sync surfaces. Every write lands locally first, and remote
work goes through a retrying outbox (`sync_queue`).

- **Export** writes everything to one readable file.
- **Restore merges and never replaces**: rows already on the phone win, and the
  user sees what the file will add before it runs.
- The repositories are pure and the outbox is generic, so a further sync target
  would sit beside the Google Calendar adapter rather than replacing anything.

---

## 7. Store requirements

**In the app:**

- **Privacy policy and Terms of use** links in Settings → About, read from
  `EXPO_PUBLIC_PRIVACY_URL` / `EXPO_PUBLIC_TERMS_URL`. Set both for a store
  build; `docs/privacy.md` and `docs/terms.md` are the published versions.
- **Delete all data** (Settings → Your data), gated on typing ERASE.
- **Export everything** — the portability half of a data request.
- **Permission usage strings** for microphone, speech, calendar and location in
  `app.config.ts`, each saying what the access is for.
- **Permissions requested in context**; location is asked for on the Places
  screen when a reminder needs it.
- **`ITSAppUsesNonExemptEncryption: false`** declared, so export compliance does
  not stall each build.
- **Restore purchases**, prices from the store, and renewal terms on the
  paywall (`app/plans.tsx`).

**At submission:**

- **App Privacy / Data safety answers.** `DEPLOY.md` §4 has the per-type table;
  `app.config.ts` → `ios.privacyManifests` is the shipped declaration it must
  agree with.
- **Screenshots and description.** Capture conventions are in
  `docs/media/SHOTS.md`.
