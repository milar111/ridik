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
| **A plan's monthly allowance** | `TIER_ALLOWANCE` in `src/services/billing/entitlement.ts` | Code — needs a release |
| **Paywall selling points** | RevenueCat → Offering → Metadata → `benefits` (array of strings) | Within 30 min, or next launch |
| **Which plan is badged** | Same metadata → `highlight`: `"monthly"` or `"yearly"` | Same |
| **Free-trial length** | App Store Connect / Play Console, on the product | Next launch |
| **Assistant model, spend caps** | In-app: Profile → tap Version ×7 → Developer | Immediately |
| **The entitlement's name** | RevenueCat, plus `EXPO_PUBLIC_REVENUECAT_ENTITLEMENT` | Next build — no code |
| **Which RevenueCat / OneSignal project** | `EXPO_PUBLIC_REVENUECAT_*`, `EXPO_PUBLIC_ONESIGNAL_APP_ID` | Next build — no code |

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
3. Create an **entitlement** and attach every product to it. Plans differ by
   *allowance*, not by feature, so they all grant the same entitlement — how
   much it allows is read from the product identifier, which must contain
   `light`, `standard` or `unlimited`. Anything unrecognised is treated as
   `standard`: a mis-named product should under-serve and be noticed, never hand
   out an uncapped assistant by accident.

   The app looks up **one** entitlement identifier and a mismatch is silent —
   everybody simply looks unsubscribed. It defaults to `assistant`, which is
   what shipped; call it something else (`Ridik Pro`) and set
   `EXPO_PUBLIC_REVENUECAT_ENTITLEMENT` to match. Rename it in the dashboard and
   in that variable together and no code changes.
4. Create an **offering**, mark it current, and add a package per product using
   RevenueCat's standard identifiers: `$rc_monthly` and `$rc_annual`.
5. Copy the two **public SDK keys** (they start `appl_` and `goog_`).

`app.config.ts` reads all three from the environment, so nothing about your
project is committed:

```bash
EXPO_PUBLIC_REVENUECAT_IOS_KEY=appl_xxxxxxxxxxxxxxxxxxxx
EXPO_PUBLIC_REVENUECAT_ANDROID_KEY=goog_xxxxxxxxxxxxxxxxxxxx
EXPO_PUBLIC_REVENUECAT_ENTITLEMENT=assistant   # only if you renamed it
```

The SDK is already installed (`react-native-purchases`). After changing any of
these, rebuild — they are compiled in:

```bash
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
keeps its own calendar and can still mirror to the phone's. **Free** — no paid
account, no card, and it does not need the Apple or Google developer accounts.

Budget about 25 minutes. Everything happens at
<https://console.cloud.google.com>.

#### a. A project and the API

1. Top-left project picker → **New project** → name it `Ridik` → Create.
2. Make sure the picker now says Ridik. Everything below is per-project and it
   is easy to configure someone else's by accident.
3. **APIs & Services → Library** → search *Google Calendar API* → **Enable**.
   Nothing else needs enabling; the app asks for calendar, `openid` and `email`
   and nothing more.

#### b. The consent screen, before any client

Google will not let you create a client until this exists.

4. **APIs & Services → OAuth consent screen**.
5. User type **External**, unless you have a Workspace organisation and only
   ever want your own domain to sign in.
6. App name `Ridik`, your email as both support and developer contact.
7. **Scopes → Add or remove scopes**, and add exactly:

   ```
   https://www.googleapis.com/auth/calendar
   openid
   email
   ```

   `.../auth/calendar` is a **sensitive** scope. That is fine and expected — it
   just means the app stays in **Testing** until you submit it for
   verification, and in Testing you must add every account that will sign in
   under **Test users**. Add your own address now; a missing test user surfaces
   as `access_blocked`, which reads like a bug in the app and is not one.

#### c. Three client ids

**Credentials → Create credentials → OAuth client ID**, three times.

| Type | What it asks for | Value |
| --- | --- | --- |
| **iOS** | Bundle ID | `ai.raisen.ridik` |
| **Android** | Package name | `ai.raisen.ridik` |
| | SHA-1 certificate fingerprint | see below |
| **Web application** | nothing required | leave the redirect fields empty |

The **Web** client is not for a website. Google's installed-app clients cannot
complete the token exchange on their own, so the app uses the web client id for
that step. Creating only two clients is the usual mistake and it fails at the
last moment of a sign-in that otherwise looked fine.

For the Android SHA-1, from the repo root:

```bash
# The debug key — for running it on your own phone or a simulator.
keytool -list -v -keystore ~/.android/debug.keystore \
  -alias androiddebugkey -storepass android -keypass android | grep SHA1

# The upload key — for anything that goes to Play. Created by `npm run release
# keystore`, and gitignored, because it is the one credential that cannot be
# rotated.
keytool -list -v -keystore credentials/android/upload.keystore | grep SHA1
```

Add **both** fingerprints to the Android client. A build signed with a key
Google has never seen fails with `DEVELOPER_ERROR` and no further explanation.

If you later use Play App Signing, Google re-signs your upload with *its own*
key — take that SHA-1 from **Play Console → Setup → App integrity** and add it
as a third.

#### d. Into the app

```bash
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=1234-abc.apps.googleusercontent.com
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=1234-def.apps.googleusercontent.com
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=1234-ghi.apps.googleusercontent.com
```

Then `npx expo prebuild --clean` and rebuild — these are read at build time, so
editing `.env` and reloading changes nothing.

Client **ids** are public by design and belong in the build. The client
**secret** does not: it is never needed by an installed app, and putting it in
one publishes it to anybody who unzips the `.apk`.

#### e. When it does not work

The three failures, and what each actually means:

- **`redirect_uri_mismatch`** — the redirect the app sent is not one Google
  accepts for that client. Installed-app clients only accept the *reversed*
  client id scheme (`com.googleusercontent.apps.<id>:/oauthredirect`); the
  `ridik://` scheme works only for the web client. `redirectUriFor()` in
  `src/services/calendar/googleAuth.ts` already picks the right one per
  platform — if you see this, the client id in `.env` is almost always the
  wrong *type* for the platform you are running on.
- **`access_blocked` / "Ridik has not completed the Google verification
  process"** — the consent screen is in Testing and the account signing in is
  not on the Test users list.
- **`DEVELOPER_ERROR` on Android** — the SHA-1 of the key that signed the build
  is not on the Android client.

### 2.4 Google Maps (optional)

Only for the map picker in Places, and **Android only** — iOS uses Apple Maps
with no key. Full steps in `SETUP.md` §5c.

### 2.5 OneSignal — remote push (optional)

Only for pushes the *server* sends. Everything the app schedules for itself —
reminders, the briefing, location alerts — is `expo-notifications` and needs
none of this.

1. Create a OneSignal app; add both platforms (iOS bundle id and Android
   package are both `ai.raisen.ridik`).
2. iOS needs an **APNs .p8 key** uploaded to OneSignal, and push enabled on the
   provisioning profile. Android needs the **Firebase service account JSON**.
   Both live in the OneSignal dashboard, never in this repo.
3. Set the App ID — it is a public identifier, and the SDK takes it at runtime,
   so it is the only value the app needs:

```bash
EXPO_PUBLIC_ONESIGNAL_APP_ID=00000000-0000-0000-0000-000000000000
```

Unset, the app initialises nothing and behaves exactly as it did before push
existed.

One thing *is* compiled in and cannot be changed from a dashboard: `mode` in the
`onesignal-expo-plugin` entry writes the `aps-environment` entitlement. Store
and TestFlight builds must be built with `ONESIGNAL_MODE=production`; anything
else silently receives no pushes on iOS, because a development entitlement
listens to the sandbox APNs host and Apple sends to the live one.

```bash
ONESIGNAL_MODE=production npx expo prebuild --clean
```

The plugin also adds a **Notification Service Extension** target to the iOS
project (confirmed delivery, badges, images). It sits alongside the WidgetKit
target and shares nothing with it but the App Group list, which both plugins
append to rather than overwrite.

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
2. **Subscriptions**: create one Subscription Group (e.g. "Ridik Assistant") and
   put every tier in it — `ridik_light_monthly`, `ridik_standard_monthly`,
   `ridik_unlimited_yearly`, or whatever set you decide to sell. One group is
   what lets someone move between tiers instead of buying two, and Apple
   handles the proration.

   The identifier has to contain the tier word. That is how the app knows what
   the subscription allows.
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
2. **Subscriptions**: create one subscription with a base plan per tier, each
   auto-renewing. Same naming rule — the product id carries the tier.
3. Complete the **Data safety** form. Same answers as Apple's.
4. Upload to **internal testing** first. Play Billing does not work at all in a
   build that has not been through the Play servers, so a local build cannot
   test purchases.

---

## 5. Building

Start here, always:

```bash
npm run release doctor
```

It reports what is present, what is missing and what that blocks — the JDK
version, the Android SDK, the upload key, and whether there is a code-signing
identity in your keychain. Everything below assumes it came back clean.

### The store artefacts

```bash
npm run release keystore      # once, ever — creates the Android upload key
npm run release bump          # advance the build number on both platforms

npm run release android:aab   # → dist/ridik-1.0.0-2.aab   (upload to Play)
npm run release android:apk   # → dist/ridik-1.0.0-2.apk   (sideload, testers)
npm run release ios:ipa       # → dist/ridik-1.0.0-2.ipa   (App Store Connect)

npm run release all           # doctor, then everything this machine can build
```

Add `--verbose` to see the whole build log instead of the last thirty lines of
a failure, and `--no-prebuild` to skip regenerating `ios/` and `android/` when
you know nothing native changed.

**The upload key is the one credential you cannot rotate.** `npm run release
keystore` writes it to `credentials/android/`, which is gitignored. Play matches
every future upload against the key that signed the first one; lose it and
updating your own app becomes a support ticket. Back up both files somewhere
that survives this machine.

**Build numbers.** `ios.buildNumber` and `android.versionCode` live in
`app.config.ts` and must increase with every upload, even when `version` has
not changed. `npm run release bump` advances both to the same number, so
"build 7" means the same thing in TestFlight and in Play.

### If you would rather not build locally

EAS builds on Apple's and Google's behalf and holds the credentials for you,
which is the easier road if you have no Mac or no certificates:

```bash
npx eas build --platform ios --profile production
npx eas build --platform android --profile production
npx eas submit --platform ios
```

### Debug builds, for the simulators

Not uploadable — they load JavaScript from Metro. See `AGENTS.md` → Verifying a
change for the full loop.

```bash
npx expo prebuild --clean
npx expo run:ios
export JAVA_HOME="$HOME/.jdks/temurin-21/Contents/Home"   # 25 fails the CMake step
npx expo run:android
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

**If you change what the widgets show:** bump `WIDGET_SNAPSHOT_VERSION` in
`src/services/widgets/snapshot.ts` and the two constants that mirror it (see
`AGENTS.md` → Widgets). A widget from the previous build then says "Ridik was
updated" instead of drawing a half-decoded face, and rights itself the first
time the user opens the app. Five widgets ship: Today, Agenda, Tasks, Habits
and List, the same five on both platforms.

**If the assistant breaks:** it fails soft. The app falls back to offline
pattern matching, and every local feature keeps working. Check your backend
first, then the provider's status page.

---

## 8. Known gaps before you ship

Honest list. See `AGENTS.md` for the full one.

- **iOS Live Activities** fall back to a notification. The WidgetKit target now
  exists (`targets/RidikWidget/`), so this is a Swift widget-extension view away
  rather than a whole target away.
- **Google Calendar sync has never run against the live API.** Every path is
  tested against a mocked transport; no request has reached Google.
- **The LLM path has only run against the mock provider.** The client, its retry
  and repair loops and the prompt are all tested; no request has been made with
  a real key.
- **The map picker** is an address search with a pin, not a map. `SETUP.md` §5c.

The first thing to do with a real key and a real device is speak one sentence
and watch what lands. That is the one path nothing here can prove for you.
