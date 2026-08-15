# Shipping Ridik

Everything you have to do outside this repository, in the order it has to happen,
and what to do with it afterwards.

`SETUP.md` explains *why* each choice was made. This file is the checklist.

---

## 0. What you can change without touching code

Worth knowing first, because it decides how much of this is one-time work.

| Thing | Where you change it | Takes effect |
| --- | --- | --- |
| **Subscription prices** | App Store Connect / Play Console | Next app launch |
| **Which plans are offered** | RevenueCat → Offerings | Next app launch |
| **Paywall selling points** | RevenueCat → Offering → Metadata → `benefits` (array of strings) | Within 30 min, or next launch |
| **Which plan is badged** | Same metadata → `highlight`: `"monthly"` or `"yearly"` | Same |
| **Free-trial length** | App Store Connect / Play Console, on the product | Next launch |
| **Assistant model, spend caps** | In-app: Profile → tap Version ×7 → Developer | Immediately |

Everything else — screens, copy outside the paywall, the palette — is code and
needs a release.

**Prices are never hardcoded.** The app renders whatever string the store gives
it, already formatted in the buyer's currency. Changing a price in App Store
Connect changes what the app shows, with no build.

---

## 1. Accounts you need

| Account | Cost | What it is for |
| --- | --- | --- |
| Apple Developer Program | $99/year | Shipping to the App Store at all |
| Google Play Console | $25 once | Same, for Android |
| RevenueCat | Free under $2.5k/month tracked revenue | One subscription that means the same thing on both stores |
| Google Cloud | Free tier | Calendar sync (optional), Maps (optional) |
| An LLM provider | Usage-based | The assistant. See §3 |

---

## 2. Keys and where they go

Nothing secret belongs in this repository. Two kinds of value:

- **Publishable** — safe to compile into the app. They go in `app.config.ts`
  under `extra`, and they are visible to anyone who unzips your build. That is
  fine; they are designed for it.
- **Secret** — must never be in the app. They live on your backend or in a
  dashboard. If a key can spend money on its own, it is secret.

### 2.1 RevenueCat (required for subscriptions)

1. Create a project. Add both apps — the iOS bundle id `ai.raisen.ridik` and the
   Android package `ai.raisen.ridik`.
2. Create your subscription products **in the stores first** (§4), then import
   them into RevenueCat.
3. Create an **entitlement** with the exact identifier `assistant`, and attach
   both products to it. The app looks up that string; a different one silently
   means nobody is ever subscribed.
4. Create an **offering**, mark it current, and add the two packages using
   RevenueCat's standard identifiers: `$rc_monthly` and `$rc_annual`.
5. Copy the two **public SDK keys** (they start `appl_` and `goog_`).

Then, in `app.config.ts`:

```ts
extra: {
  revenueCat: {
    ios: 'appl_xxxxxxxxxxxxxxxxxxxx',
    android: 'goog_xxxxxxxxxxxxxxxxxxxx',
  },
},
```

And install the SDK:

```bash
npx expo install react-native-purchases
npx expo prebuild --clean
```

The app switches from the sandbox provider to the real one automatically —
`src/services/billing/revenuecat.ts` checks for both the package and a key for
the current platform. Confirm it took: Profile → Version ×7 → the Assistant
group names the active provider.

> **The secret RevenueCat key never goes in the app.** It is for server-to-server
> calls only.

### 2.2 The assistant (required)

The app can reach a model two ways. Pick one:

**Hosted (what you want for the stores).** Requests go through a backend you run,
which holds the provider key and checks the caller is subscribed. Reference
implementation in `server/`. Set:

```ts
extra: { assistantApiUrl: 'https://api.yourdomain.com/interpret' }
```

The provider key lives on that server as an environment variable and never ships.

**Personal key (your own builds only).** Leave `assistantApiUrl` empty and paste
a key into Profile → Version ×7 → Developer → Assistant key. It is kept in the
device keychain. A store build hides this field entirely.

> Do not ship a build with a provider key compiled in. Anyone can extract it and
> spend your money.

### 2.3 Google Calendar sync (optional)

Only needed if you want two-way sync with Google Calendar. Without it the app
keeps its own calendar and can still mirror to the phone's.

1. Google Cloud → enable **Google Calendar API**.
2. Create OAuth client ids: one iOS (bundle id), one Android (package name +
   SHA-1 of your signing certificate), one Web (used by the token exchange).
3. Put the client ids in `app.config.ts` under `extra.googleOAuth`. The **client
   secret is secret** — it belongs on your backend, not in the app.

### 2.4 Google Maps (optional)

Only for the map picker in Places, and **Android only** — iOS uses Apple Maps
with no key. Full steps in `SETUP.md` §5c.

---

## 3. Before you build

```bash
npm install
npm run typecheck        # must be clean
npm test                 # must be clean
```

Then check `app.config.ts`:

- `version` — bump for every store submission.
- `ios.buildNumber` and `android.versionCode` — must increase every upload, even
  for a rejected build you are replacing.
- `extra` — the keys from §2.

---

## 4. Store setup

### App Store Connect

1. Create the app record with bundle id `ai.raisen.ridik`.
2. **Subscriptions**: create a Subscription Group (e.g. "Ridik Assistant") and
   two auto-renewable subscriptions inside it — monthly and yearly. One group
   matters: it is what lets a user switch between them rather than buying both.
3. Set prices per territory. You set one and Apple proposes the rest.
4. Fill in the **App Privacy** questionnaire. Ridik stores everything on-device;
   the only data leaving the phone is the sentence you speak, sent to the
   assistant. Say so.
5. Add a **Privacy Policy URL** and **Terms of Use (EULA) URL**. Apple requires
   both for auto-renewable subscriptions, and both are linked from the app's
   Profile screen — make sure those point somewhere real before submitting.
6. Review notes: give them a test account and say the assistant needs a
   subscription, or reviewers will report it as broken.

### Play Console

1. Create the app with package `ai.raisen.ridik`.
2. **Subscriptions**: create one subscription with two base plans, monthly and
   yearly, each auto-renewing.
3. Complete the **Data safety** form. Same answers as Apple's.
4. Upload to **internal testing** first. Play Billing does not work at all in a
   build that has not been through the Play servers, so a local build cannot
   test purchases.

---

## 5. Building

```bash
# Native projects, after any config or native dependency change
npx expo prebuild --clean

# iOS — needs Xcode
npx expo run:ios --configuration Release

# Android — needs JDK 21, not 25
export JAVA_HOME="$HOME/.jdks/temurin-21/Contents/Home"
npx expo run:android --variant release
```

For store builds, EAS is less painful than doing it by hand:

```bash
npx eas build --platform ios --profile production
npx eas build --platform android --profile production
npx eas submit --platform ios
```

---

## 6. Testing purchases before release

Purchases cannot be tested on a simulator. Both stores need a real device and a
real build.

- **iOS**: App Store Connect → Users and Access → Sandbox Testers. Sign out of
  the App Store on the device first, then let the purchase sheet prompt you.
  Sandbox subscriptions renew every few minutes so a year passes in an hour.
- **Android**: add your account under Licence Testing in Play Console, and
  install from the internal testing track.

On a simulator the app uses its own sandbox provider instead: the flow is
walkable, everything is badged **Sandbox**, prices show as `—`, and no money
moves. It never ships — the real provider takes over the moment §2.1 is done.

---

## 7. Keeping it running

**Watch these:**

- RevenueCat's dashboard for failed renewals. The app already handles the grace
  period — a user whose card fails keeps the assistant and is told to fix it —
  but a spike means something is wrong with a product configuration.
- Your assistant provider's spend. The app has its own caps (Developer →
  Requests per day / per month) but those are per-device; your backend needs its
  own ceiling.

**When you change a price:** do it in the store. The app picks it up with no
release. Existing subscribers keep their old price until they consent to the new
one — both stores handle that for you, and neither lets you raise a price
silently.

**When you update the app:** bump `version` and the build numbers. Migrations
are append-only (`src/db/migrations.ts`) — never edit a shipped one, or an
existing user's database will be left half-upgraded.

**If the assistant breaks:** it fails soft. The app falls back to offline
pattern matching, and every local feature keeps working. Check your backend
first, then the provider's status page.

---

## 8. Known gaps before you ship

Honest list. See `AGENTS.md` for the full one.

- **Home-screen widgets** are not built. The data layer is
  (`src/services/widgets/`) and it is fed on every change, but the native
  extensions — a WidgetKit target on iOS, an AppWidgetProvider on Android — do
  not exist yet. Nothing else depends on them.
- **iOS Live Activities** fall back to a notification. Needs the same WidgetKit
  target.
- **Google Calendar sync has never run against the live API.** Every path is
  tested against a mocked transport; no request has reached Google.
- **The LLM path has only run against the mock provider.** The client, its retry
  and repair loops and the prompt are all tested; no request has been made with
  a real key.
- **The map picker** is an address search with a pin, not a map. `SETUP.md` §5c.

The first thing to do with a real key and a real device is speak one sentence
and watch what lands. That is the one path nothing here can prove for you.
