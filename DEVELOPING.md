<!--
  The developer half of the README, moved out on purpose.

  The README is the first thing a person deciding whether to trust this app
  with their calendar reads, and a stack table is not an answer to that
  question. Everything a contributor needs is here instead; `AGENTS.md` has the
  invariants and the traps.
-->

# Developing Ridik

## The stack

| Layer | Choice | Why |
| --- | --- | --- |
| App | Expo SDK 57, React Native 0.86, React 19, TypeScript strict | Native modules via prebuild, one codebase |
| Routing | expo-router (typed routes) | File-based, deep-linkable from a notification or a widget |
| Storage | expo-sqlite + Drizzle | Everything reads and writes locally, instantly |
| Server state | TanStack Query | Optimistic mutations, precise invalidation |
| Motion | Reanimated 4 | Spring physics, interruptible, reduced-motion aware |
| Model | Gemini, behind a provider interface | Swappable; the tool contract is the app's, not the vendor's |
| Billing | RevenueCat, behind a provider interface | One entitlement means the same thing on both stores |

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
  services/             calendar sync, billing, focus timers, geofencing, notifications, widgets
  features/             home, briefing, consent, export, voice dock
  hooks/                TanStack Query hooks — the only way a screen touches data
  ui/                   design tokens and primitives
  startup/              bootstrap sequence
```

Four rules hold it together:

1. **Every timestamp crossing a boundary is UTC epoch milliseconds.** Wall-clock strings exist only
   where the model speaks and where the screen renders. `src/core/time.ts` owns every conversion, so
   a DST transition cannot move a stored instant.
2. **The model never sees an id.** It refers to things the way you said them; resolution happens in
   the executor, where a near-tie becomes a spoken question instead of a wrong write.
3. **Repositories are pure.** No `expo-*` import anywhere under `src/repositories`, so the test suite
   drives the real Drizzle driver against real SQLite — the code path that ships, not a mock.
4. **A fuzzy match may answer "I don't know."** `resolveOne()` returns `none | unique | ambiguous`,
   and an ambiguous match becomes a question. A wrong resolve destroys data silently, which is the
   one failure this app is built to make impossible.

`AGENTS.md` records the rest — every invariant, and the platform details worth knowing before you
change an area.

---

## Running it

```bash
npm install
npx expo prebuild            # regenerates ios/ and android/ from app.config.ts
(cd ios && pod install)      # prebuild --no-install skips this and deletes the workspace

npx expo start               # Metro

npm run ios

export JAVA_HOME=/path/to/jdk-21   # the Android build requires JDK 21
npm run android
```

Requires Node 20+, Xcode 26+ with an iOS 26 simulator, the Android SDK with platform 36, and **JDK
21**. This is a bare debug build rather than Expo Go — `expo-dev-client` is deliberately absent so
a debug build loads Metro directly, which keeps simulator verification fully scriptable.

### Configuration

**Nothing secret is committed.** The Gemini key is entered in the app and stored in the device
keychain, never in the database and never in the bundle — anything prefixed `EXPO_PUBLIC_` is
readable inside the shipped `.apk`. Everything below is a publishable identifier, and every
subsystem no-ops when its value is missing rather than failing:

```bash
EXPO_PUBLIC_REVENUECAT_IOS_KEY=appl_…      # unset → a local sandbox that sells nothing
EXPO_PUBLIC_REVENUECAT_ANDROID_KEY=goog_…
EXPO_PUBLIC_REVENUECAT_ENTITLEMENT=…       # unset → `assistant`
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=…         # unset → no calendar sync
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=…
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=…
```

`DEPLOY.md` has the dashboard steps.

### Testing

```bash
npm test              # the full suite: logic, UI and server projects
npm run test:logic    # plain Node — repositories, migrations, the LLM engine, services
npm run test:ui       # jest-expo — component tests
npm run typecheck
npm run seed          # a realistic database, written through the real repositories
```

`logic` runs under plain Node against real SQLite via a `node:sqlite` shim of expo-sqlite's
synchronous surface, so repository tests exercise the driver that ships. `npm run seed` builds a
populated database and pushes it into whichever simulators are running — it is both a demo and an
end-to-end exercise of the data layer.

CI runs typecheck, lint, the full suite and a prebuild of both platforms on every push; compiled
apps are built by a separate, manually-triggered workflow.

---

See `AGENTS.md` for the invariants that hold this together, and `WIDGETS.md` for the widget
contract.
