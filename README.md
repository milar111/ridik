# Ridik

A voice-first personal operating system for iOS and Android. You talk; it files.

One utterance can create a calendar event, cancel another, append a bullet to a note and add three
items to a shopping list — in one pass, offline-first, on-device.

```
"Remind me to call Ivo at 4, cancel my Math homework reminder for Sunday,
 and note down that the robotics lab needs 10k resistors."
    -> calendar_add      { title: "Call Ivo", start: "…T16:00" }
    -> calendar_delete   { target: { query: "Math homework", on_date: "…" } }
    -> note_update       { target: { query: "robotics lab" }, append_bullets: ["10k resistors"] }
```

## What it does

- **Multi-intent voice capture.** One utterance can create, cancel and note at the same time; every
  action is applied independently and reported separately, so a failure in one does not lose the rest.
- **Calendar with judgement.** Events sync to Google and mirror to the phone's own calendar. Anything
  with a location or classified as an exam gets a 20-minute travel/prep block in front of it, and the
  block follows the event when it moves and disappears when it is cancelled. Booking — or moving —
  onto an occupied slot asks first and offers the next free slot.
- **Schedule inference.** Ridik knows your weekly timetable, so "homework for Math, page 42" lands
  the day before your next Math class without being told when that is.
- **Dependency-chain tasks.** "I can't start assembly until the frame is printed and the servos
  arrive" builds a real DAG. Blocked work is hidden from the daily list until it unlocks, and
  cycles are refused rather than deadlocked.
- **Projects, events and trips.** Say "for my Japan trip, remind me to pack slippers" and it lands as
  a checkbox in the right section. Tasks, notes, lists and spending filed anywhere against a project
  show up on it.
- **Structured notes**, deliberately never sorted or searchable by date, with FTS5 search.
- **Micro-ledger, habits with streaks, transient checklists, a micro-CRM** of people and the promises
  you made them, **background geofence reminders**, and **focus sessions** that survive the app being
  killed.
- **A 15-second spoken morning briefing** built from all of it, plus markdown / PDF / clipboard /
  email export of your week.
- **A backup that can come back.** Settings → Your data → Backup writes every row to one JSON file
  and can restore it onto any install. Restoring **merges**: it adds what is missing and never
  deletes or overwrites what is already there, and it says so before it runs.
- Long-press the home-screen icon to start talking without opening a screen.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| App | Expo SDK 57, React Native 0.86, React 19, TypeScript strict | Native modules via prebuild, one codebase |
| Routing | expo-router (typed routes) | File-based, deep-linkable from notifications |
| Storage | expo-sqlite + Drizzle ORM | Everything reads/writes locally and instantly |
| Server state | TanStack Query | Optimistic mutations, precise invalidation |
| UI state | Zustand | The voice session is global, not tree-shaped |
| LLM | Google Gemini via a provider abstraction | Swappable for an on-device model later |
| Validation | Zod v4 | Nothing the model emits reaches the database unvalidated |
| Time | Luxon | Every stored instant is UTC epoch ms; zones resolve at the edges |
| Speech | expo-speech-recognition (on-device) + Whisper fallback + expo-speech | Works in a quiet room and a noisy lab |

## Architecture

The app is one screen — a microphone, what is next, and a receipt for the last thing it did.
Everything else lives behind the hamburger in `app/menu.tsx`.

```
app/                    expo-router routes (screens only)
  index.tsx             home: the mic, and nothing that has not earned its place beside it
  menu.tsx              every other destination, on one page
src/
  core/                 pure primitives — clock, time, Result, fuzzy match, logger, format
  db/                   schema, versioned SQL migrations, cross-runtime SQLite driver
  repositories/         one typed repository per domain; no native imports, fully testable
  llm/                  tool contract (Zod), prompt builder, provider clients, executor, orchestrator
  voice/                STT, VAD, TTS, Whisper fallback
  services/             calendar sync, focus timers, geofencing, notifications, background tasks
  features/             home, briefing, export, voice dock
  hooks/                TanStack Query hooks — the only way screens touch data
  ui/                   design tokens and primitives
  startup/              bootstrap sequence
```

Three rules hold the whole thing together:

1. **Every timestamp crossing a boundary is UTC epoch milliseconds.** Wall-clock strings exist only
   where the model speaks and where the screen renders. `src/core/time.ts` owns every conversion, so
   a DST transition can never move a stored instant.
2. **The model never sees an id.** It refers to things the way the user said them; resolution happens
   in the executor, where a near-tie becomes a spoken question instead of a wrong write.
3. **Repositories are pure.** No `expo-*` import anywhere under `src/repositories`, so the test suite
   drives the real Drizzle driver against a real SQLite engine (`node:sqlite`) — the same code path
   that ships to the device, not a mock.

### The database

`src/db/migrations.ts` owns the DDL as hand-written, versioned SQL keyed on `PRAGMA user_version`.
`src/db/schema.ts` mirrors it for type-safe queries. Migrations run inside a transaction each, and
the FTS5 migration is skipped (not failed) when the runtime lacks FTS5, with notes search falling
back to `LIKE`.

## Prerequisites

- Node 20+ (developed on 25)
- Xcode 26+ with an iOS 26 simulator
- CocoaPods — `brew install cocoapods`
- Android SDK with platform 36, build-tools 36, an arm64 system image and an AVD
- **JDK 21** for the Android build. JDK 25 fails the CMake configure step with
  `A restricted method in java.lang.System has been called`. A copy is installed at
  `~/.jdks/temurin-21`:

  ```bash
  export JAVA_HOME="$HOME/.jdks/temurin-21/Contents/Home"
  ```

## Running

```bash
npm install
npx expo prebuild            # regenerates ios/ and android/ from app.config.ts
(cd ios && pod install)

npx expo start               # Metro

# iOS
npm run ios

# Android — JAVA_HOME must point at JDK 21
export JAVA_HOME="$HOME/.jdks/temurin-21/Contents/Home"
npm run android
```

This is a bare debug build, not Expo Go: the app loads its bundle straight from Metro at
`localhost:8081`. `expo-dev-client` is deliberately **not** installed — its launcher screen requires
a manual tap that blocks automated verification, and a plain debug build loads the packager
directly.

## Configuration

Nothing secret is committed. Voice needs a Gemini API key, entered in **Settings → Voice** and stored
in `expo-secure-store` (never in the database). Without a key the app still works: the mock provider
falls back to pattern matching for the common commands, and every non-voice surface is unaffected.

Google Calendar sync needs OAuth client ids, read from the environment at build time:

```bash
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=…
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=…
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=…
```

Subscriptions and remote push are the same shape — publishable identifiers, read
from the environment, and each subsystem no-ops when its value is missing rather
than failing. `DEPLOY.md` §2 has the dashboard steps.

```bash
EXPO_PUBLIC_REVENUECAT_IOS_KEY=appl_…      # unset → the sandbox billing provider
EXPO_PUBLIC_REVENUECAT_ANDROID_KEY=goog_…
EXPO_PUBLIC_REVENUECAT_ENTITLEMENT=…       # unset → `assistant`
EXPO_PUBLIC_ONESIGNAL_APP_ID=…             # unset → no remote push
ONESIGNAL_MODE=production                  # build-time only; store builds need it
```

## Testing

Two Jest projects:

```bash
npm test              # both
npm run test:logic    # plain Node — repositories, migrations, LLM engine, services
npm run test:ui       # jest-expo — component tests
npm run typecheck
```

`logic` runs in plain Node against real SQLite through a `node:sqlite` shim of expo-sqlite's
synchronous surface, so repository tests exercise the shipped Drizzle driver rather than a fake.

### Demo data

```bash
npm run seed
```

Builds a realistic database — a timetable, a trip and a robotics project, a dependency chain, a
buffered meeting, streaks, spending, people and promises — by writing through the *real*
repositories, then pushes the file into whichever simulators are running. It is both a way to see
the app populated and an end-to-end exercise of the data layer. `RIDIK_SEED_PUSH=0` builds the file
without installing it.

Note: `@testing-library/react-native` v14 is fully async — `render`, `rerender`, `unmount` and
`fireEvent` all return promises and must be awaited, or act() scopes leak and every query silently
returns nothing.
