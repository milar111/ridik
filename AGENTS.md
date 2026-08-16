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
- **Nothing decides who may spend money except `resolveAssistantBudget()`.** Three states that
  used to be one: no store in the build (personal — keep the developer caps), an active
  entitlement (the plan, floored by them), and free on a store build (a *lifetime* trial of
  `TRIAL_TOTAL_REQUESTS`, then no billable call at all). Never branch on `monthlyAllowance()`
  alone — it answers 0 for both "nothing bought" and the Unlimited tier, and 0 means *uncapped*
  to `usage.ts`, which is exactly how a free user inherited 200 requests a day of the operator's
  Gemini budget. `isStoreBuild()` is the only thing that can tell the first two apart, and the
  trial is counted for the life of the install (`llmTrialRequestsUsed`) because a free monthly
  allowance is a subscription nobody is charged for. When the door shuts, voice still runs
  through the offline matcher and the turn carries a `notice` saying so — a silently dumber
  assistant is the failure `LastAction` exists to prevent.
- **One decision, then one measurement.** `resolveAssistantBudget()` says *who* may spend and
  hands its ceilings straight to `createUsageMeter().check()`, which says *how much has been*.
  Nothing sits between them reinterpreting a number, because that gap is where the two used to
  disagree about what `0` meant. Ceilings travel as `Cap`, never as a bare number:
  `developerCap(n)` is the only thing allowed to read the developer rows' `0` as "no ceiling",
  and `limitOf(0)` refuses every call. A ceiling may be stated in requests, tokens or
  `costMicros` and the first unit crossed stops the turn — the free trial says both, because
  25 requests is 25 *turns* and one turn dragging a huge context bills like fifty. Tokens and
  money are estimated before the call from this user's own rolling average and reconciled after
  from what the provider reported, and the estimate errs towards refusing: one unnecessary
  offline answer costs less than one uncapped call.
- **Nothing reaches a provider without `assistantConsent === 'granted'`.** The check is the
  first statement in `clientForTurn()` — before the endpoint, before the keychain, before the
  budget — because a consent check that runs after the request is the specific thing Apple's
  5.1.2(i) guidance rejects for, and one that runs after the client is built is one a fourth
  provider mode can skip. Whisper is gated too: it uploads the *recording*, to a second third
  party, and "off by default" is not the promise the screen makes. Three states, never a
  boolean — `unset` opens the first-run screen, `declined` must never see it again, and both
  refuse equally. **Unreadable is `unset`.** A database that will not open cannot be evidence
  that anyone agreed to anything. Refusing degrades to the offline matcher with a `notice` and
  a way back, exactly as a spent trial does; `src/llm/consent.ts` owns the words and names the
  provider, and it is named because naming it is the requirement.
- **Every outbound path is behind the same gate, and every recipient is on the same screen.**
  There are four ways personal data can leave this phone and only one of them looks like it:
  the model (`clientForTurn`), the *recogniser* (`onDeviceOnly` in `src/voice/types.ts` —
  on-device is preferred and is simply unavailable on most Android devices, and the session
  then streams the audio to Apple's or Google's speech servers), Whisper
  (`src/voice/whisper.ts`, which posts to OpenAI), and the briefing push
  (`services/notifications/push.ts`, whose `briefing_line` tag is `composeVisual`'s own
  sentence, complete with event titles and people's names). Adding a fifth means adding
  `mayReachProvider` to it **and** a sentence to `ConsentScreen`: a grant obtained with a
  disclosure that understates is worse than no disclosure, because it is the thing the grant
  was obtained with. `ASSISTANT_PROVIDER`, `WHISPER_PROVIDER` and `PUSH_PROVIDER` in
  `src/llm/consent.ts` are the names, and `consent-screen.test.tsx` asserts all three reach
  the screen.
- **A yes answers the question it was asked and no other.** Two questions ride the same yes/no
  envelope: the review gate's "is this what you said?" (built before any handler has looked at
  the data, so it can never mention a clash) and a handler's own "is this what you meant?".
  `ConfirmScope` in `src/llm/confirm.ts` keeps them apart, `ExecuteOptions` carries `reviewed`
  and `confirmed` separately, and the pending envelope records which one each parked action was
  blocked on. Collapsing them into one flag meant the utterances heard *worst* were exactly the
  ones that lost the double-booking guard. And when a batch blocks more than one action, the
  question that gets spoken is chosen by `alwaysAsks`, not by source order — otherwise "add
  milk and log fifty on groceries" asks about the milk and books the €50 unseen.

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

A sheet is `SHEET` in `app/_layout.tsx`, and it is the one place where the two
platforms deliberately take **different** options to reach the same result:
`modal` on iOS, `formSheet` on Android. They are not interchangeable —
`formSheet` on iOS renders the screen with no height at all, so the sheet
appears correctly shaped and completely empty, and plain `modal` on Android is a
full-screen push with no card and no gesture. Matching the *option* is what
produced two different screens; matching the *result* needs two options. **And it must always draw its own Close.** The
menu shipped for one commit with the drag as its only exit, which on iOS meant
there was simply no way off it: the gesture is invisible, it is the first thing
to fail for anyone with a motor impairment, and Android users reach for system
Back long before they think to swipe.

Two Android text traps, both of which cost a debugging session:

- **A `Text` in a flex row is measured short and clipped, not wrapped.** With
  tracking on it, short by a whole character — "YOUR DATA" rendered as
  "YOUR DAT". Give it `flex: 1` rather than letting it size to its own content.
- **Nothing may lay out text before the fonts resolve.** React Native caches
  text measurements on Android, and the navigator has to mount on the first
  render, so screens were measured with the fallback face and the cache kept
  those numbers forever. A paragraph measured at two lines drew three, and the
  third was covered by whatever came next — "…listens and understands." stopped
  at "and", but only on the first screen opened after launch, which is why it
  read as intermittent. `Screen` and `app/index.tsx` hold their content on
  `useFontsReady()`; any new root-level screen must too.
- **Glyph ink can reach past its advance width, and Android clips to the
  advance.** Bricolage's `t` and `e` do: "Export" lost its crossbar and became
  "Exporl", while "Allow" was fine. `Button`'s label carries 2pt of horizontal
  slack for this; any other tight text container needs the same.

## The receipt has to be announced

This app is safe because it *shows* you what it did — and every one of those
things is a card that springs up in silence. With VoiceOver or TalkBack on, the
receipt, the review gate's preview and the notice that says the assistant has
stopped calling the model were not degraded, they were absent. `src/ui/a11y.ts`
carries the rule; the short version:

- **A surface that appears with news on it carries `accessibilityLiveRegion`
  *and* calls `useAnnounceOnIOS` with the same sentence** — one prop and one
  call, one platform each. The prop is Android's mechanism
  (`announceForAccessibility` is discouraged there from API 34); the call is
  UIKit's, which has no live regions at all. Announcing on *both* platforms
  beside a region is how a sentence gets said twice. `useAnnounce` is the
  exception, for state no element's text carries word for word: the mic caption
  *becomes* the partial transcript, so a live region on it interrupts on every
  syllable.
- **One voice per event.** `HomeMic` and `LastAction` own the status and the
  result on home; `VoiceDock` announces them only when it is not on home, where
  its sheet is the only report a turn gets.
- **Anything that is only a colour or a glyph has to be said.** A failed result
  row was a red triangle, an in-flight undo a 50% dim, "working" a swapped
  glyph — `accessibilityState` and the label carry those now.
- **A gesture is never an exit.** The voice sheet's grab handle is a `Pressable`:
  a bare `View` is not an accessibility element unless told to be, and
  `onAccessibilityTap` is iOS-only, so TalkBack had nothing to activate.
- **`ConsentGate` is a lid for touches only.** A screen reader walks the view
  tree, so `accessibilityViewIsModal` (iOS) and `ConsentShield` in
  `app/_layout.tsx` (Android, which has no such prop) are what stop it reaching
  the microphone underneath the one screen nobody may skip.

None of it has been through a real screen reader; the tests assert the props and
the announcements exist, which is all a simulator can do.

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

**The developer screen is behind a switch, not behind a gesture.** Seven taps
set `developerMode`; expo-router will match `ridik:///developer` regardless, so
`app/developer.tsx` redirects on the switch itself. Anything added there is
reachable by deep link until that check says otherwise.

**A number on that screen has to say whether it is good.** `latency_ms` was
written on every turn since the orchestrator was built and read by nothing, so
the app measured how slow it was and threw the measurement away.
`llmInteractions.latency()` is the reader: median and p95, nearest-rank so both
are durations a real turn had, over a *window* of recent turns — a lifetime
median cannot answer "did it get slower?", because a thousand fast turns bury
the hundred slow ones after them. `LATENCY_TARGET_P95_MS` is what the tail is
held to and the row tones warning past it. Nothing enforces the target; a
read-out that cannot say whether it is bad is a decoration, and judging a prompt
or model change by feel is how a regression ships.

## The money path

One decision, then one measurement, and four states that must never collapse
into each other. `src/services/billing/allowance.ts` is the whole decision and
it is pure; everything else feeds it.

- **"Free" and "we could not ask" are different answers.** `Entitlement.known`
  is the difference. A store read that throws returns `UNKNOWN`, and a turn on
  an unknown entitlement changes nothing — no lock, no trial charge, nothing
  said to the user about money. Collapsing the two hard-locked paying
  subscribers out of the assistant on the first network blink, and marched
  their trial counter towards the lock while it did it.
- **A cap is a `Cap`, never a number.** `0` means "unlimited" in the developer
  rows and "nothing bought" in a tier allowance. Only `developerCap()` may read
  a 0 as unlimited; `limitOf(0)` refuses everything.
- **The trial is stated before it is spent, not when it runs out.** For a long
  time `describeTrial()` was imported by exactly one file — `app/developer.tsx`,
  behind seven taps — so a free user's first news of a 25-request limit was the
  warning that fires with five left. It is on `/consent`, where the decision to
  send anything is taken, and in the Plan row on `app/settings.tsx`. Both hold
  it until the entitlement has *answered* and both check `known`: `isStoreBuild()`
  is module state that is false until a provider registers, and telling a
  subscriber in a tunnel how many free requests they have left is the same lie
  in the other direction.
- **`requests` is utterances; `calls` is what the provider billed.** One turn
  can bill three times when a reply has to be repaired. Plans are sold in
  requests, so repairs go in `calls` — adding them to `requests` charges the
  user for the app's own retries.
- **The trial is a lifetime ledger, not a meter window.** It lives in
  `services/billing/trialLedger.ts` in two units and two stores, and `llm_usage`
  never enforces it: that table counts a local day and a calendar month, both
  of which are windows on a clock the user can set, and neither of which knows
  whether the traffic in it was paid for. Move the trial into the meter and a
  subscriber is refused their first free turn because of their own paid ones.
- **Nothing may lower `llmTrialRequestsUsed` or `llmTrialTokensUsed`.** Not a
  button, not "Erase everything" (`db/wipe.ts` preserves those rows and
  `llm_usage`), not a reinstall (SecureStore mirrors them; iOS Keychain
  survives deletion, Android does not — the backend is the real anchor there).
  `services/billing/__tests__/reset-surfaces.test.ts` reads the source and
  fails if a new one appears.
- **A build with a backend URL is a store build**, whatever the billing
  provider says. `revenuecat.isAvailable()` is false when an environment
  variable is missing, which silently registers the provider that reports
  `sells: false` — so the hosted path forces `storeBuild: true` rather than
  asking. It also applies no developer caps, because those sliders are hidden
  on that build and an invisible 3,000/month would cap an Unlimited subscriber.
- **The meter's clock only ratchets.** `snapshot()` measures the later of the
  device's local date and the newest date ever recorded, so winding the clock
  back cannot open an empty window. Winding it *forward* still can, and is left
  alone: it is indistinguishable from time passing, and the server owns the
  authoritative quota on the build where that matters.

## Backups, and not losing what was said

Two features, one idea: nothing the user produced may be thrown away by the app
on their behalf.

- **A restore MERGES. It never replaces.** `src/features/export/json.ts` owns
  the whole decision and states it at the top of the file. A row whose id is
  already here is skipped and the copy on the phone wins; a row clashing with a
  *different* row (same habit name, same place label) is skipped and counted; a
  row whose parent did not survive has its link cleared where the column allows
  it and is dropped where it does not. There is not one `UPDATE` and not one
  `DELETE` in the importer, and there must never be — replace is a one-tap way
  to destroy a month of work with a stale file and there is no undo underneath
  it. The whole thing is one transaction: a constraint is a skip, anything else
  rolls back, because a half-restored database is worse than a failed restore.
  **The user is told which it is before it runs** — `describeImport()` writes
  the sentence, `app/backup.tsx` puts it in a `useConfirm()` with the counted
  consequence for that particular file, and `backup-screen.test.tsx` fails if
  the question stops saying it.
- **Two versions travel and they move for different reasons.**
  `BACKUP_VERSION` is the envelope; `schemaVersion` is `PRAGMA user_version` at
  the time. A file from a *newer* build of either is refused by name rather
  than half-decoded. An older one is fine — migrations are append-only, so it
  is missing columns rather than carrying wrong ones, and they take their
  declared defaults.
- **`llm_usage` and `sync_queue` do not travel**, for the same reasons
  `db/wipe.ts` preserves the first: it is the operator's spend meter, not a
  possession, and a file that could write it could be edited to unspend a
  trial. The second is an outbox of half-finished calls to somebody else's
  calendar. `notes_fts` does not travel either — it is derived, and
  `useRestoreBackup` rebuilds it, because nothing but the notes repository
  maintains it.
- **A transcript is the only record that a sentence was ever spoken.** The
  audio is discarded as soon as it is transcribed. So `store.ts` keeps an
  unanswered one in `recovered`, which `close()` and `reset()` deliberately do
  **not** clear — only `recoverTranscript()` (which hands it to the composer)
  and `discardRecovered()` do, plus that same sentence succeeding. A recogniser
  that dies mid-utterance leaves its last partial there, because most of a long
  dictation is worth incomparably more than nothing. And a session that
  recorded *nothing at all* sets `heardNothing`, which says so in those words:
  "I didn't quite catch that" over a microphone that captured a whole paragraph
  of silence is how somebody finds out days later.

## Where a file goes

**This repository is public.** Anything an agent writes that is not shipped
code, shipped docs or a test goes in `notes/`, which is gitignored — working
lists, audits, research write-ups, migration plans, exit strategies. They are
genuinely useful and none of them are things a stranger reading the source
should have to wade through; several also name prices, keys by variable, or
decisions that have not been taken yet. `BACKLOG.txt` and
`REMOVING-ONESIGNAL.md` predate the convention and are ignored by name.

The same rule in the other direction: `README.md`, `AGENTS.md`, `WIDGETS.md`
and `DEPLOY.md` *are* shipped, and are read by people deciding whether to trust
this app with their calendar.

## Environment gotchas

- **Android needs JDK 21.** JDK 25 fails `configureCMakeDebug` with
  `A restricted method in java.lang.System has been called`. Build with
  `export JAVA_HOME="$HOME/.jdks/temurin-21/Contents/Home"`.
- **`src/app/` is a forbidden directory name.** expo-router prefers `src/app` over `./app` as its
  route root; creating it silently moves the whole route tree and every screen becomes
  "Unmatched Route". Startup code lives in `src/startup/`.
- **The root layout must mount its navigator on the first render.** Gating `<Stack>` behind an async
  bootstrap leaves expo-router unable to match the initial URL. Bootstrap state is an overlay drawn
  over the navigator, not a replacement for it. `ConsentGate` is the third of these and the
  reason it is not a redirect from `app/index.tsx`: a launch can land on `/tasks` from a
  reminder or `/today` from a widget, and a first-run gate that only guards the front door is
  not a gate. It also draws nothing until the row has actually been read — `useSetting` reports
  the declared default while the query is in flight, which here would put a full-screen consent
  sheet over the first frame of every launch.
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

**There is no `adb shell input tap` for the iOS simulator.** `simctl` can boot,
install, launch, `openurl` and screenshot, and that is the whole list — nothing
in it touches the screen. So anything behind a tap (a paywall card, a purchase
dialog, a confirm) is reached one of three ways:

- `xcrun simctl openurl booted 'ridik:///plans'` for navigation. **Terminate the
  app first.** Sent to a *running* app the URL raises an "Open in Ridik?" system
  alert that then needs a tap, which is the problem you were avoiding; a cold
  launch routes straight there with no prompt.
- Seed the state in SQLite. The database is at
  `$(xcrun simctl get_app_container booted ai.raisen.ridik data)/Documents/SQLite/ridik.db`
  and `app_settings` holds JSON-encoded values, so consent becomes
  `insert or replace into app_settings values('assistantConsent','"granted"',<ms>)`.
  Terminate first — the app holds the WAL open.
- Clicking through AppleScript, for what neither of those reaches. The device
  screen fills the window with no bezel, so a point on the device maps to the
  desktop as `origin + point * (window_width / device_width)` — for an iPhone
  17 Pro that is a 402pt-wide screen in a 456px window, so `×1.134` from the
  window origin reported by `position of window 1`. This needs Accessibility
  permission for the terminal, and macOS can revoke it mid-run.

The simulated app exposes **no accessibility tree** to System Events — `entire
contents of window 1` returns nothing — so there is nothing to query by name and
coordinates are the only address.

Two things that waste a session on the way there. `expo prebuild --no-install`
skips CocoaPods, which deletes `ios/Ridik.xcworkspace` and leaves `xcodebuild`
reporting only that the workspace "does not exist" — run `pod install` after any
iOS prebuild. And after a prebuild the simulator's LaunchServices record goes
stale, so `simctl launch` fails with `SBMainWorkspace` denying the request no
matter how many times the app is reinstalled or the device rebooted;
`xcrun simctl erase` is what clears it.

Those are debug builds and cannot be uploaded anywhere. The shippable artefacts
come from `npm run release` — `doctor` first, which reports what is missing
before a build spends twenty minutes discovering it. `credentials/` holds the
Android upload key and is gitignored; it is the one credential that cannot be
rotated, because Play matches every future upload against the key that signed
the first one.

## Widgets

**`WIDGETS.md` is the contract** — geometry, copy, empty states and the three
invariants, normative for both platforms. Read it before touching a face; read
this section for what will bite you while you do.

One payload, five faces per platform. `src/services/widgets/snapshot.ts` builds it; everything
a widget draws is computed there, where it can be tested under plain Node, because neither
WidgetKit nor an `AppWidgetProvider` can run this app's JavaScript or open its SQLite file.

Four numbers have to agree across four files, and nothing fails loudly when they do not:

| What | Where |
| --- | --- |
| `WIDGET_SNAPSHOT_VERSION` | `snapshot.ts`, `SnapshotStore.supportedVersion` (Swift), `WidgetSnapshot.SUPPORTED_VERSION` (Kotlin) |
| `ROW_CAP` = 6 | `snapshot.ts`, `RidikRowsFace.ROW_SLOTS`, `ROW_SLOTS` in the Android plugin |

**Bump the version whenever the payload shape changes.** An older widget reading a newer
payload draws "Ridik was updated" rather than a half-decoded face — that is the whole point of
the field, and skipping the bump is how a widget silently renders a lie.

**A colour resolved at draw time is resolved in the wrong process.**
`resources.getColor()` inside a provider answers against the *app's*
configuration; the launcher draws the tile against its own. Flip the system to
dark with the app last run in light and every runtime-coloured string is written
near-black onto a near-black tile — which is exactly what happened, and only the
strings were affected, because everything else came from the layout's own
`@color/` references. `setColorStateList` fixes it in a line and is API 31; this
app ships to 26. So widget colour lives in XML, and anything that varies —
done/not-done, or the user's chosen ember — is a *second pre-coloured view* or a
*second generated resource*, never a computed int.

**Android resolves every resource id by name** (`Resources.getIdentifier`), because the layouts
are injected into the *app* module by `plugins/withRidikAndroidWidget.js` and a library cannot
see the app's `R`. Rename an id in the plugin without changing `RidikRowsFace.kt` and the build
stays green while the widget renders blank. Both lists are kept adjacent to each other for that
reason: `ROW_IDS` in the plugin, `RowIds` in the Kotlin.

**RemoteViews cannot loop and cannot set a width.** So the row slots are written out six times
in the layout and hidden when unused, and the lead column's width is a *layout variant* rather
than a runtime value — `ridik_rows` (46dp), `ridik_rows_ampm` (66dp) and `ridik_rows_tight`
(16dp), picked per kind and per `DateFormat.is24HourFormat`. A 12-hour device given the 46dp
lead truncates every row to "10:00 …".

**The row count comes from the launcher, per widget id.** `AppWidgetManager.getAppWidgetOptions`
is read in `drawRows`, so the same face is three rows tall in one corner of the home screen and
six in another; `onAppWidgetOptionsChanged` is wired for the same reason, or a resize would
redraw without re-cutting the list.

**Publishing waits for the checklists.** Today's snapshot resolves a beat before them, and a
payload published in that gap carries `list: null` — which the list widget correctly draws as
"No lists yet" over a list that exists. `useWidgetPublisher` holds the first publish until the
list queries have *settled*, not succeeded, so a failing one cannot hold the other four hostage.

**`ridik:///?speak=1` is the only address in this app that is a verb.** Every widget, the
launcher long-press, the iOS control and the Android tile point at it, and `app/index.tsx`
consumes it through `useSpeakIntent`. Two things about that are easy to break:

- **A parameter is a value, not an event.** Read naively it starts a listening session on every
  re-render, again on the way Back from the menu, and again every time the OS resumes the app
  with the same URL still set. It is cleared as it is consumed, and re-armed only when the flag
  goes away — `src/features/voice/__tests__/speak-intent.test.tsx` has one test per path.
- **It waits, it does not fire and fail.** These entry points produce cold launches almost
  exclusively, which is precisely when the pipeline is a bootstrap step that has not run yet;
  firing early gets "Voice is still starting up." where the whole product should be. The gate is
  `pipelineReady` plus a foregrounded app, and the intent is *held* rather than dropped, so a
  tap made too early is honoured the moment it can be rather than thrown away.
- **A push may not carry it.** `PUSH_BLOCKED_PARAMS` in `briefingPush.ts` refuses the flag on
  any route, because the thing to block is the *parameter*: the segment is home, and a briefing
  that could not open home would be the wrong fix. The parameter was meaningless until the URL
  grew a verb — it stood in that file's own test as the example of a query string surviving —
  so a notification quietly gained the ability to start a recording session.
- **It must not open the microphone underneath `ConsentGate`.** The gate is an overlay, so home
  is mounted and live beneath it, and an unwired speak intent would make the one address that is
  a verb the one way past the one screen that cannot be skipped. `app/index.tsx` passes
  `consentAnswered`, and it is *answered* rather than *granted* — `hasAnsweredConsent` in
  `src/llm/consent.ts` — because declining leaves a working app whose offline matcher still
  files a plain sentence, and gating on `granted` would kill the mic tile for ever on a rung
  that never needed the network. Nothing is consumed while it waits: clearing the flag under the
  lid would lose the tap.

**The mic on a tile is medium and large only, on both platforms.** A `.systemSmall` widget has
exactly one tap target, so a `Link` there is inert — the same glyph would open the reading
screen on iOS and the microphone on Android. `SpeakAffordance` and the plugin's `header()` each
carry half the rule.

## Known gaps

Honest list. Everything else in the brief is built, tested and has been run on both simulators.

- ~~Home-screen widgets~~ — five of them, built and verified on both home screens: Today,
  Agenda, Tasks, Habits and List. `modules/ridik-widgets` is the bridge; each widget runs in
  its own process and can only read what the app published, so
  `src/services/widgets/snapshot.ts` owns the payload shape and every face decodes it.
  See **Widgets** below for what will bite you.
- **The old note, kept because the transport half is what mattered:** `src/services/widgets/`
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
  `src/features/voice/useQuickActions.ts` now routes to `ridik:///?speak=1` rather than calling
  the store — but a launcher long-press cannot be faithfully simulated over adb, so the
  tap-through has only been reasoned about, not observed. The route itself can be, and is:
  `adb shell "am start -a android.intent.action.VIEW -d 'ridik:///?speak=1'"`.
- **The system control and the Quick Settings tile have not been tapped on a device.** The iOS
  control type-checks against the 26.5 SDK at a 16.4 deployment target and the Kotlin compiles
  and its manifest entry merges (`:app:processDebugResources`), but placing a Control Center
  button or a QS tile is a launcher gesture, exactly like the shortcut above. The URL they open
  is the one every other entry point opens and is covered end to end.
- ~~A refetch failure over a cached Today snapshot is invisible~~ — `StaleNotice` in
  `src/features/today/Fallbacks.tsx` says so, quietly: the day stays on screen, with the time the
  snapshot was taken and a way to try again. It is deliberately not an error — nothing broke and
  the day is still probably right — but a stale day is indistinguishable from a current one, which
  is why it has to be stated at all.
- **Google Calendar sync is untested against the live API.** Every path is covered against a mocked
  transport — offline, backoff, auth loss, last-write-wins — but no OAuth client ids were available,
  so nothing has spoken to Google.
- **The LLM path has only run against the mock provider.** The Gemini client, its retry and repair
  loops and the prompt are all tested; no request has been made with a real key.
