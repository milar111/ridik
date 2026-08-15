# Ridik — working notes

Expo has changed a lot: read the exact versioned docs at
https://docs.expo.dev/versions/v57.0.0/ before writing native-facing code.

Read `README.md` first for the stack and architecture. This file records the things that will bite
you if you do not know them.

## Invariants — do not break these

- **UTC epoch milliseconds everywhere.** Every timestamp in SQLite, in a repository signature and on
  the wire is epoch ms. Wall-clock strings exist only at two edges: what the LLM emits and what a
  screen renders. All conversion goes through `src/core/time.ts` (Luxon, named IANA zones). Never
  do date arithmetic by hand and never call `new Date()` for maths.
- **`now()` from `src/core/clock.ts`, never `Date.now()`.** Tests freeze the clock; a direct
  `Date.now()` makes a module untestable and its bugs unreproducible.
- **Repositories stay pure.** Nothing under `src/repositories/**` may import `expo-*`, `react` or
  `react-native`. That purity is what lets the `logic` test project run them under plain Node
  against real SQLite. Native work belongs in `src/services/**`.
- **Screens touch data only through `src/hooks`.** Never call `getRepositories()` from a component;
  it bypasses the query cache and the optimistic-update paths.
- **Fuzzy matches must be able to say "I don't know".** `resolveOne()` returns
  `none | unique | ambiguous`. An ambiguous match becomes a spoken question, never a guess — a wrong
  resolve silently destroys the user's data.
- **Migrations are append-only.** `src/db/migrations.ts` is keyed on `PRAGMA user_version`. Never
  edit a shipped migration; add a new one. `src/db/schema.ts` must be kept in step with it.

## The shape of the app

One screen. `app/index.tsx` is a microphone, the next thing on the calendar, and
a receipt for the last thing the assistant did. Every other screen is behind the
hamburger in `app/menu.tsx`; there is no tab bar, and the `(tabs)` group is gone
— route groups never appeared in the URL, so `/notes`, `/calendar` and every
deep link kept working unchanged when the files moved up a level.

Two rules fall out of that and are easy to break by accident:

- **The receipt is not decoration.** Speaking is fast because you do not have to
  look, which is exactly why a mis-heard word would otherwise land silently and
  stay wrong. `LastAction` is the only thing that closes that loop. Undo is an
  allow-list in `src/features/home/undo.ts`, not a rule — a tool belongs on it
  only when it always creates exactly one row *and* the id it reports is that
  row. `habit_log` reports the habit, not the log entry; `note_create` upserts.
  Both would destroy data if wired by pattern.
- **Home must not import `@/features/today`.** That barrel pulls in every
  section of the Today screen and with them the briefing's text-to-speech and
  the focus runtime. Home needs three pure things from it and imports them from
  their modules.

## The look — "element"

A saturated warm ground lit as though the microphone were the heat source. The
vernacular is a maker lab: an element coming up to temperature, not a sunset.
Rules that are easy to break without noticing:

- **`heat` is not a text colour.** `heat.core` is the vivid ember and only ever
  appears as a large fill or a gradient stop. `colors.accent` is the darkened
  one that clears 4.5:1 on the sand ground; anything with words in it uses that.
- **Nothing is neutral grey.** Every "black" is a warm brown, every "white" is
  linen. A true grey next to this palette reads as a bug.
- **The mono is rare on purpose.** Martian Mono is for times and for `eyebrow`
  region labels. It is *not* `micro` — `micro` is small secondary text with a
  hundred-odd call sites, and setting that in the mono put a wide monospace
  under every agenda row in the app.
- **`weight` on `<Txt>` swaps the font family, not `fontWeight`.** Once a style
  names a font file, iOS ignores `fontWeight` outright and Android synthesises
  it by smearing the glyphs — the same label would look bold on one platform and
  unchanged on the other.
- **Android does not count `letterSpacing` when measuring a line.** A tracked
  label sized to its own content gets ellipsised early ("TAP TO S…"). Give
  tracked text an explicit width and centre it with `textAlign`.

`HeatField` carries all of it. Two lessons are baked into that file: Reanimated
cannot animate `Stop` or `RadialGradient` (they live in `<Defs>` and render no
host view), and *scaling* the glow to "flood" the screen drags its falloff over
everything and turns the page a flat mid-brown — so heat comes from a second,
tighter core layer while the base field barely moves.

On home the voice sheet stays shut unless it needs something (a clarification,
an error, or typing). The screen is already the voice interface, and a scrim
over it hides the one thing the app is for.

## The two platforms must look the same

Anything React Native draws with the platform's own widget looks like two
different products. These are banned; use the replacement:

| Banned | Use instead | Why |
| --- | --- | --- |
| `Switch` | `Toggle` | UISwitch vs Material 3 — different size, travel, thumb, and a check glyph Android paints inside it |
| `Alert.alert` | `useConfirm()` | Two OS dialogs that ignore the palette, disagree about button order, and Android has no `destructive` style |
| `ActivityIndicator` | `Spinner` | Tapered ticks vs a sweeping arc |
| `shadowColor`/`elevation` | `elevate()` from `src/ui/shadow.ts` | Android ignores every iOS shadow prop and cannot colour or offset `elevation` |
| bare `RefreshControl` | `Refresh` | `tintColor` is iOS-only, `colors` Android-only |

Two Android text traps, both of which cost a debugging session:

- **A `Text` in a flex row is measured short and clipped, not wrapped.** With
  tracking on it, short by a whole character — "YOUR DATA" rendered as
  "YOUR DAT". Give it `flex: 1` rather than letting it size to its own content.
- **Glyph ink can reach past its advance width, and Android clips to the
  advance.** Bricolage's `t` and `e` do: "Export" lost its crossbar and became
  "Exporl", while "Allow" was fine. `Button`'s label carries 2pt of horizontal
  slack for this; any other tight text container needs the same.

## What belongs on the Settings screen

The test: **if a stranger set this to the worst possible value, would the app
still work?** A timezone text field fails it — one typo and every date is wrong.
A model name fails it. "Speak replies" passes.

Everything that fails the test lives on `app/developer.tsx`, reached by tapping
Settings → Version seven times. Nothing was deleted; it was moved, and
`src/ui/__tests__/settings-screen.test.tsx` asserts each one stays off the main
screen so they cannot drift back one convenience at a time.

Permissions are surfaced **by need, not inventoried**. A list of four rows with
green ticks is a developer's view of the system. The screen tells you about a
permission only when something you switched on cannot work without it, and sends
a hard-blocked one to system settings instead of offering a button the OS will
never honour again.

## Environment gotchas

- **Android needs JDK 21.** JDK 25 fails `configureCMakeDebug` with
  `A restricted method in java.lang.System has been called`. Build with
  `export JAVA_HOME="$HOME/.jdks/temurin-21/Contents/Home"`.
- **`src/app/` is a forbidden directory name.** expo-router prefers `src/app` over `./app` as its
  route root; creating it silently moves the whole route tree and every screen becomes
  "Unmatched Route". Startup code lives in `src/startup/`.
- **The root layout must mount its navigator on the first render.** Gating `<Stack>` behind an async
  bootstrap leaves expo-router unable to match the initial URL. Bootstrap state is an overlay drawn
  over the navigator, not a replacement for it.
- **`expo-dev-client` is intentionally absent.** Its launcher needs a manual tap, which breaks
  automated simulator verification. A plain debug build loads Metro directly.
- **RNTL v14 is fully async.** `render`, `rerender`, `unmount` and `fireEvent` all return promises.
  An unawaited one leaks an `act()` scope into the next test and every query there returns nothing.
- **`drizzle-orm/expo-sqlite` must be imported from `/driver`.** The package index also exports
  `useLiveQuery`, which pulls in the native module and makes the file unloadable under Node.
- **Gestures inside a React Native `Modal` need their own `GestureHandlerRootView`.**
  A `Modal` is a separate native window, and gesture-handler only routes touches inside a root
  view — so a `GestureDetector` in a modal registers fine and then silently never receives
  anything. There is no warning; the gesture just does nothing.
- **The recogniser talks after it is stopped.** Cancelling usually surfaces as an error a moment
  later, which would land on a store the user has already dismissed and leave the mic red with a
  message nobody can read. `store.ts` guards every callback with a session ticket; a late
  transcript must not be executed either.
- **`adb shell input text` typed at an unfocused field reaches the dev menu.** The characters
  arrive as key events: two `r`s inside the double-tap window reload the bundle, and a space
  activates whatever button holds focus — usually a sheet's backdrop, which closes it. The failure
  looks like the app crashing or dismissing itself. Confirm focus first
  (`adb shell dumpsys input_method | grep mInputShown`) and only then type. `keyevent 111` (ESC)
  is not a keyboard-dismiss either; it reaches the app and closes the modal.
- **`&` in a deep link must be escaped for the device shell**, or everything after it is dropped:
  `adb shell "am start ... -d 'ridik:///notes?pane=lists\&list=Hardware'"`.

## Verifying a change

```bash
npm run typecheck
npm test

# iOS
xcrun simctl boot "iPhone 17 Pro"; npx expo start
xcrun simctl install booted ios/build/Build/Products/Debug-iphonesimulator/Ridik.app
xcrun simctl launch booted ai.raisen.ridik
xcrun simctl io booted screenshot /tmp/shot.png

# Android
adb reverse tcp:8081 tcp:8081
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n ai.raisen.ridik/.MainActivity
adb logcat -d -s ReactNativeJS -s AndroidRuntime
```

A change is not verified until it has run on both.

## Known gaps

Honest list. Everything else in the brief is built, tested and has been run on both simulators.

- **Home-screen widgets have a producer but no transport.** `src/services/widgets/`
  builds and diffs the payload — tested, and fed on every data change — but a widget reads a
  shared App Group (iOS) or SharedPreferences (Android), and JavaScript can reach neither.
  `publish.ts` is a capability-detected adapter looking for a `RidikWidgets` native module and
  no-opping without one. What is missing is a WidgetKit target (`@bacons/apple-targets` can
  generate one without ejecting) and an `AppWidgetProvider` or `react-native-android-widget`.
  The iOS half is the same target Live Activities need.
- **iOS Live Activities** need a Swift widget extension that a config plugin cannot generate.
  `src/services/focus/liveActivity.ts` is a capability-detected adapter: it looks for an optional
  native module and falls back to an ongoing time-sensitive notification. Wiring the real widget is
  a native task; `isSupported()` starts returning true once it exists, and nothing else changes.
- **The map picker** in `app/places.tsx` is a coordinate + radius editor with a current-location
  shortcut and reverse geocoding. A real map needs `react-native-maps`.
- **Home-screen shortcuts are registered but not tap-verified.** `adb shell dumpsys shortcut`
  confirms both actions are published to the OS, and the handler in
  `src/features/voice/useQuickActions.ts` is wired — but a launcher long-press cannot be faithfully
  simulated over adb, so the tap-through has only been reasoned about, not observed.
- **A refetch failure over a cached Today snapshot is invisible.** The screen keeps showing the last
  good day with no indication that it has stopped updating.
- **Google Calendar sync is untested against the live API.** Every path is covered against a mocked
  transport — offline, backoff, auth loss, last-write-wins — but no OAuth client ids were available,
  so nothing has spoken to Google.
- **The LLM path has only run against the mock provider.** The Gemini client, its retry and repair
  loops and the prompt are all tested; no request has been made with a real key.
