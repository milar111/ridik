# Ridik — engineering guidelines

Read `README.md` for what the app is and `DEVELOPING.md` for how to run it. This file is the set
of rules the codebase is built around. Each one is enforced by tests where it can be.

Expo changes quickly: use the versioned docs at https://docs.expo.dev/versions/v57.0.0/ before
writing native-facing code.

## Invariants

- **Time is UTC epoch milliseconds everywhere.** SQLite, repository signatures and the wire all
  carry epoch ms. Wall-clock strings exist only where the model speaks and where a screen renders,
  and every conversion goes through `src/core/time.ts` (Luxon, named IANA zones).
- **`now()` from `src/core/clock.ts`, never `Date.now()`.** Tests freeze the clock, so every
  time-dependent path is reproducible.
- **Repositories stay pure.** Nothing under `src/repositories/**` imports `expo-*`, `react` or
  `react-native`, which lets the `logic` test project run them under Node against real SQLite.
  Native work belongs in `src/services/**`.
- **Screens read data only through `src/hooks`,** so the query cache and optimistic updates are
  always in the path.
- **A fuzzy match can say "I don't know".** `resolveOne()` returns `none | unique | ambiguous`,
  and an ambiguous match becomes a spoken question rather than a guess.
- **Migrations are append-only.** `src/db/migrations.ts` is keyed on `PRAGMA user_version`;
  `src/db/schema.ts` is kept in step with it.
- **The model proposes, the executor decides.** The model returns typed actions validated with
  Zod; `src/llm/executor.ts` resolves them against real rows and applies them. Irreversible
  writes ask first, and every write is reported back on the receipt with Undo where it is safe.

## Money

- **One decision, then one measurement.** `resolveAssistantBudget()`
  (`src/services/billing/allowance.ts`) is the only place that decides who may spend on the model;
  `createUsageMeter().check()` measures what has been spent. Ceilings travel as a `Cap` type,
  never as a bare number, so "no limit" and "nothing bought" can never be confused.
- **Four states, kept apart:** personal build (no store), subscribed, trial, and *unknown*
  (the store could not be reached). Unknown never locks anyone out and never charges the trial.
- **The free trial is a lifetime ledger** (`trialLedger.ts`), counted in requests and tokens,
  mirrored to SecureStore and never lowered by any code path; `reset-surfaces.test.ts` enforces it.
- **Requests are what the user said; calls are what the provider billed.** Plans are sold in
  requests, so the app's own repair retries are never charged to the user.
- **Top-up credits are a balance, not a rate** (`credits.ts`): spent only after the plan or trial
  is used up, purchased count read from RevenueCat, used count kept where it cannot be lowered.

## Privacy and consent

- **Nothing reaches a provider without `assistantConsent === 'granted'`.** The check is the first
  statement in `clientForTurn()`. Consent has three states — `unset`, `granted`, `declined` — and
  an unreadable value is treated as `unset`.
- **Every recipient is named on the consent screen.** Each outbound destination has a
  `*_PROVIDER` constant in `src/llm/consent.ts`, and `consent-screen.test.tsx` enumerates them and
  fails if one is missing from the screen. Adding a recipient means adding a gate and a sentence.
- **Declining leaves a working app.** Voice falls back to the on-device matcher in
  `src/llm/provider/mock.ts`, and a turn that could not reach the model carries a `notice` saying
  so.
- **Analytics are off by default.** `app_events` is a local ledger; uploading requires the user's
  switch and an answered disclosure. The event vocabulary (`services/analytics/events.ts`) has no
  free-text fields, and `vocabulary.test.ts` enforces that.
- **Recordings are deleted.** Every ending of a capture session funnels through one path that
  discards the audio file, and a sweep of the cache runs at the start of each turn.

## Voice

- **An utterance is part of a conversation.** `src/llm/recall.ts` sends the last few turns inside
  a ten-minute window as history, outside the cached system prompt, carrying what was actually
  written rather than what was proposed.
- **Nothing spoken is thrown away.** A statement the model has no tool for becomes a note; a
  transcript that could not be sent is kept in the voice store until the user deals with it.
- **The recogniser answers first, a better engine may improve it.** `SpeechAnalyzer` on iOS 26,
  the platform recogniser elsewhere, and optional local whisper.cpp or AssemblyAI upgrades. A
  failed upgrade never fails the turn.
- **A yes answers the question it was asked.** The review gate and a handler's own confirmation
  are separate scopes (`ConfirmScope` in `src/llm/confirm.ts`).

## One screen

`app/index.tsx` is a microphone, the next thing on the calendar, and a receipt for the last turn.
Everything else is behind the menu (`app/menu.tsx`).

- **The receipt (`LastAction`) is the safety net.** Undo is an allow-list in
  `src/features/home/undo.ts`: a tool is on it only when it always creates exactly one row and
  reports that row's id.
- **Home does not import `@/features/today`;** it imports the three pure helpers it needs directly.
- **What the user sees is what the model sees.** The conversation shown on home is the same window
  `recall.ts` sends.

## Both platforms look the same

| Instead of | Use | Why |
| --- | --- | --- |
| `Switch` | `Toggle` | UISwitch and Material switches differ in size, travel and thumb |
| `Alert.alert` | `useConfirm()` | OS dialogs ignore the palette and order buttons differently |
| `ActivityIndicator` | `Spinner` | Platform spinners look unrelated |
| `shadowColor` / `elevation` | `elevate()` from `src/ui/shadow.ts` | Android ignores iOS shadow props |
| bare `RefreshControl` | `useRefresh()` (a hook) | Consistent tint on both platforms |

- A sheet is `SHEET` in `app/_layout.tsx` (`modal` on iOS, `formSheet` on Android) and always
  draws its own Close.
- Text that must not truncate gets `flex: 1` or an explicit width; screens wait for
  `useFontsReady()` before laying out text.
- Surfaces that appear with news carry `accessibilityLiveRegion` and announce on iOS through
  `useAnnounceOnIOS` (`src/ui/a11y.ts`).

## The look

- `heat.core` is a fill, never a text colour; readable accents use `colors.accent`.
- Two semantic temperatures — warm (live, needs you) and cool (settled, done). Severity is carried
  by weight, not by extra hues.
- Nothing is neutral grey. `weight` on `<Txt>` swaps the font family rather than setting
  `fontWeight`. Martian Mono is for times and eyebrow labels only.
- `Card` and `Section` render nothing when they have no children.

## Widgets

`WIDGETS.md` is the contract. The payload is built and tested in
`src/services/widgets/snapshot.ts`; `WIDGET_SNAPSHOT_VERSION` is bumped whenever its shape changes
and must match the Swift and Kotlin readers. `targets/RidikWidget/` is the source of truth for the
iOS extension and is copied into `ios/` at prebuild.

## Settings

A setting belongs on the main Settings screen only if the app still works at its worst value.
Everything else lives on the developer screen (`app/developer.tsx`), and
`settings-screen.test.tsx` keeps it there.

## Backups

A restore merges and never replaces: existing rows win, clashes are skipped and counted, and the
whole import runs in one transaction (`src/features/export/json.ts`). The user is told the
consequence before it runs.

## Verifying a change

```bash
npm run typecheck
npm test
```

Then run it on both platforms and look at the screen, not only the log:

```bash
# iOS
xcrun simctl launch booted ai.dby.ridik
xcrun simctl io booted screenshot /tmp/shot.png

# Android
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n ai.dby.ridik/.MainActivity
adb exec-out screencap -p > /tmp/shot.png
```

Environment notes: Android builds need JDK 21; never create `src/app/` (expo-router would treat it
as the route root); `pod install` needs a UTF-8 locale; after `expo prebuild --clean`, rewrite
`android/local.properties` with the SDK path.

Working notes, audits and plans go in `notes/`, which is gitignored.
