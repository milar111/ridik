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
- **Every outbound path is behind a gate, and every recipient is on the same screen.**
  The second half of that sentence is the invariant; the first half has one documented
  exception and is stated loosely for that reason. Six ways data can leave this phone, and
  only one of them looks like it: the model (`clientForTurn`), the *recogniser*
  (`onDeviceOnly` in `src/voice/types.ts` — on-device is preferred and is simply unavailable
  on most Android devices, and the session then streams the audio to Apple's or Google's
  speech servers), Whisper (`src/voice/whisper.ts`, which posts to OpenAI), the briefing push
  (`services/notifications/push.ts`, whose `briefing_line` tag is `composeVisual`'s own
  sentence, complete with event titles and people's names), the usage upload
  (`services/analytics/upload.ts`) and crash reports (`services/analytics/crash.ts`).
  A purchase reaches RevenueCat and the geocoder reaches the platform's maps service; neither
  is gated — a store build talks to the store — and both are named on the screen anyway,
  because the rule is *every recipient*, not every optional one.
  Adding another means adding a gate **and** a sentence to `ConsentScreen`: a grant obtained
  with a disclosure that understates is worse than no disclosure, because it is the thing the
  grant was obtained with. `ASSISTANT_PROVIDER`, `WHISPER_PROVIDER`, `PUSH_PROVIDER`,
  `ANALYTICS_PROVIDER`, `CRASH_PROVIDER` and `STORE_PROVIDER` in `src/llm/consent.ts` are the
  names — and `consent-screen.test.tsx` no longer takes a list on trust: it *enumerates every
  `*_PROVIDER` the module exports* and fails if one of them is not on the screen. It used to
  assert two names as literals, which made it an allow-list a fifth recipient walked straight
  past. Adding a seventh constant without a sentence is now a red test with that name in the
  diff.
- **The one gate that is not `mayReachProvider`, and why.** `mayUploadAnalytics()` requires
  the switch to be on **and** the disclosure to have been *answered* — `hasAnsweredConsent`,
  not `mayReachProvider`. Requiring `granted` would mean that refusing to send your words to
  Google also refuses an anonymous counter with no identity in it, which is a different
  decision from the one the person took. What the invariant protects is kept in full: the
  disclosure was read, both recipients are named on it, and the switch is off by default — so
  this path is strictly harder to open than the four that use `mayReachProvider`, not easier.
  If the strict reading is ever preferred, change one identifier in that one function.
- **A yes answers the question it was asked and no other.** Two questions ride the same yes/no
  envelope: the review gate's "is this what you said?" (built before any handler has looked at
  the data, so it can never mention a clash) and a handler's own "is this what you meant?".
  `ConfirmScope` in `src/llm/confirm.ts` keeps them apart, `ExecuteOptions` carries `reviewed`
  and `confirmed` separately, and the pending envelope records which one each parked action was
  blocked on. Collapsing them into one flag meant the utterances heard *worst* were exactly the
  ones that lost the double-booking guard. And when a batch blocks more than one action, the
  question that gets spoken is chosen by `alwaysAsks`, not by source order — otherwise "add
  milk and log fifty on groceries" asks about the milk and books the €50 unseen.
- **One gate reads the words; every other one reads the reply.** A finished utterance is
  *shown*, in the composer, and never sent until somebody presses Send. It is the only check
  in this app that fires before the model is called — `confirmMode`, the executor's review
  gate and the handlers' own questions all read actions a reply proposed, so by the time any
  of them can ask, the request has been made and billed. A recogniser that heard "doctor" for
  "tutor" is one keystroke here and a whole turn of somebody's allowance anywhere else; on a
  free install that turn comes out of a *lifetime* trial and does not come back.
  **It is not a setting.** It shipped as one for an afternoon and the switch was deleted the
  same day: the two halves are not symmetrical, because sending is one tap and unsending is
  not a thing that exists. There is no "rewind my last request" — `LastAction` undoes a
  *single* row through an allow-list, so one mis-heard sentence that filed three actions is
  three separate corrections, some of which (`note_create` upserts, `habit_log` reports the
  habit) cannot be made at all. `review.test.ts` asserts there is no seam to configure it
  through, and `settings-screen.test.tsx` asserts there is no row.
  Three things it must not become: it is not a failure (no `recovered`, no error status —
  those are for a sentence that was *lost*, and reporting a success as a loss is what the
  `reason` on `DraftSeed` exists to prevent, copy included); it must not put a database read
  in front of the microphone opening, which is why nothing is read at all any more; and it
  swallows a **clarification answer** too, which still has to carry its pending token — a
  spoken answer that arrives bare turns the second half of a two-part turn into a first half.
- **Onboarding requires all three permissions, and the gate is a dimmed button.** Not a
  renamed one: a first version made the label the explanation — "3 still needed", with a
  padlock — which reads as a *different control* appearing where the button was, and a padlock
  on a full-bleed primary looks like a paywall. `Button` already dims to 0.45 when disabled;
  the colour returning is the whole signal, and the three rows above it are the explanation.
  The label still carries the reason for a screen reader, because a dim button announces
  `disabled` and never says why.
  Two things this must keep. **`blocked` is not a dead end** — a permission the OS will not
  ask for twice raises no dialog ever again, so that row offers system settings instead of a
  button that would do nothing; requiring a permission with no way to grant it is an install
  with no way forward. And the rows are `Button`s at `sm`, not an 11pt tracked ALLOW label:
  the first version put a `micro` word where an action goes, on a screen whose own footer is a
  full-width 14pt control, and it read as a caption you could not press.
  Stated because it is the owner's call and not mine: requiring **notifications** is the part
  App Review is most likely to argue with — Guideline 5.1.1 wants an app to function when a
  non-core permission is refused.
- **OneSignal is gone, and what linking it cost is the reason to be slow about the next SDK.**
  It delivered exactly one thing — a briefing push composed from a dashboard — and in exchange
  it took `expo-notifications`' `UNUserNotificationCenter` delegate on iOS. No App ID needed
  and no JS called: it swizzled `UIApplication.setDelegate:` from a `+load` and ran
  `[OneSignal initialize:nil]` before the Expo modules registered, so a local notification
  firing while Ridik was open showed no banner and `subscribeToResponses` could not fire. It
  also logged a run of warnings about being called before its own App ID was set, which was
  its native launch path talking to itself before any of this app's code existed — unfixable
  from JS, which is what forced the choice. Removal followed `REMOVING-ONESIGNAL.md`; the
  delegate collision is gone from the log and the briefing survives as the in-app card.
  Two things went with it that were not obvious. `PUSH_PROVIDER` had to leave `consent.ts` —
  a disclosure that keeps naming a company you no longer send anything to is not harmlessly
  stale, it is wrong about where data goes, and `consent-screen.test.tsx` enumerates the
  `*_PROVIDER` exports so deleting the constant is what keeps that test honest. And
  `PUSH_BLOCKED_PARAMS` was one of *two* guards refusing `?speak=1` on a notification href;
  `safeHref` in `responses.ts` is now the only one, so it is exported and tested by name
  rather than left private. The iOS privacy manifest entries stayed — RevenueCat still
  supplies a device id and the model still receives names — only their comments changed.
- **The disclosure is required, so the only question is how it reads.** It cannot be removed
  or deferred — Apple 5.1.2(i) and Play's prominent-disclosure rule both want the recipient
  named before anything is sent, and `mayReachProvider` enforces it in code regardless. What
  it *was* is the problem it caused: "Where your words go" over four cards and about five
  hundred words of prose, in the register of a terms of service, as the first thing a new
  install ever saw. It now leads with the promise — "Your life stays on this phone", no
  account, exportable — which is the product's best claim and was being delivered as a
  disclaimer.
  The split is by **recipient, not by length**. `Panel.disclosure` marks the two that name
  one — the assistant, and the dictation service the audio reaches when the phone has no
  offline voice — and those stay above the fold; "what stays" and "never sent" are true,
  reassuring and one tap away. `never hides a recipient behind the expander` is the test that
  holds the line, because collapsing *those* would make it a screen that asks for consent
  without saying what to.
  The index is a **list**, not a sentence. That is where the length actually was: what
  `ASSISTANT_PROVIDER` receives is six or seven categories, written as one sixty-word clause
  chain held together by semicolons — accurate, unreadable, and impossible to skim for the one
  item you wanted to check. `Panel.items` draws them as lines. Nothing was cut to do it, which
  is the point: the screen reads shorter while saying the same amount.
  And the visible half is the panel body **verbatim**, through one `PanelCard` used in both
  places. A first attempt wrote a shorter summary of the index and silently dropped the
  timetable's places, task due dates, projects, note titles and spending categories — which is
  precisely the understating the `PANELS` docblock exists to warn about, reintroduced by the
  person who had just read it. The test that guards it now reads the whole
  *screen* for each category rather than one node's `children` — which is both more robust and
  a stronger guarantee, since the node-reading version would have gone green on a screen that
  had quietly dropped two of the list items.
- **The first run is four steps and the disclosure is the last one.** `ConsentGate` draws
  `WelcomeFlow` (three panels, then the permission asks), which *ends* with the same
  `ConsentScreen` it used to show directly — wrapped rather than reimplemented, because the
  disclosure is legally load-bearing and `consent-screen.test.tsx` enumerates every
  `*_PROVIDER` on it. The gate condition and the thing that closes it are both unchanged:
  answering the disclosure. There is no second flag, so an install killed halfway through the
  tour comes back to the start of it rather than to a half-onboarded state nothing can
  describe. **Skip skips the tour, never the disclosure** — there is a test named for it.
  Permissions come *before* consent, because the microphone is needed whichever way the
  disclosure is answered (declining leaves a working app whose offline matcher still files a
  spoken sentence), and asking after would make it look conditional on saying yes to Google.
  Location is deliberately not asked for: it is requested on the Places screen at the moment a
  reminder cannot be watched without it, and asking on a first run — before anybody has made
  one — is how a permission gets denied for ever by somebody who would have granted it later.
- **A guard that is silent is a guard that costs an evening.** `revenuecat.isAvailable()`
  correctly refuses a key the native SDK would reject (`NATIVE_KEY_PREFIXES` — a `test_`/`rcb_`
  Web Billing key sells nothing on a phone and killed an Android launch for six days), and
  then said nothing anybody could see: one logcat line, and a paywall reading "the store did
  not return anything to sell" — which blames a store that was never asked, because with no
  usable key the provider is not registered at all. `unavailableReason()` names the actual
  problem *and the prefix this platform needs*, the bootstrap logs it, and `/plans` shows it
  instead of the wrong sentence. The rule generalises: a guard that silently degrades has to
  be able to say why, or the next person debugs the wrong half of the system.
- **The calendar header is a back chevron and the month.** It also carried a paging stepper and
  a Today button — three ways to move through time in a 40pt row, above a grid that is the
  fourth. The arrows had already been moved once (they were either side of the label, putting
  "go back" and "previous month" side by side as identical glyphs a finger's width apart), which
  fixed the ambiguity and not the redundancy. Tapping the month opens a picker that reaches any
  month in one gesture, and Today is a day on a screen whose bottom half is the day you selected.
- **A screen's writes have to reach the outbox too, and for a long time only the assistant's
  did.** `src/llm/executor.ts` has enqueued a `sync_queue` row beside every calendar write
  since sync was built; the four write hooks in `src/hooks/useCalendar.ts` enqueued nothing.
  So an event the user *spoke* reached Google and the phone's own calendar, and the identical
  event created, edited or deleted on the calendar screen changed nothing anywhere but SQLite
  — caught on a real phone with two events sitting in the device calendar under a day the app
  showed as empty. `useDeleteEvent` even carried the comment "keeps a tombstone so the worker
  can retract the event remotely" directly over code that never told the worker anything, which
  is how it survived being read.
  Two details the fix turns on. `queueSync` takes the **row**, not the id: `enqueueEventSync`
  in the service re-reads by id, which is right for a soft delete and silently useless for a
  hard one — the row is gone, so all three remote ids come back null and the retraction has
  nothing to retract. And a travel block is a separate row with its own remote copy, so it is
  read *before* the delete and retracted on its own account.
  `calendar-sync-outbox.test.ts` reads the source and, crucially, checks its own list of write
  hooks *against the file* — a list that only holds what it already knows about is an
  allow-list, not a test, and an allow-list is what let four hooks skip the queue in the first
  place.
- **Connecting Google Calendar lives on Settings, because the calendar screen promises it
  does.** It spent a while behind the developer gate on the reasoning that it is a one-time
  setup act rather than a preference — both halves true, conclusion still wrong: `SyncBanner`
  draws "Google Calendar isn't connected" and routes to `/settings`, so the app was
  advertising a destination that existed only for somebody who had tapped Version seven
  times. It passes the screen's own test, too — the worst value a stranger can pick is "not
  connected", which is a working app whose events stay local.
- **The Android mirror is a LOCAL calendar and therefore never reaches Google.** By design and
  for a good reason (`resolveSource` — a calendar whose account does not exist is deleted by
  the provider on the next sync), but it is not what "synced" sounds like: events mirrored
  there show in the phone's Calendar app and in nothing that leaves the phone. The path to
  Google is the OAuth integration in `services/calendar/googleApi.ts`, and the calendar
  screen's banner is the one thing telling the user which of the two they have — and it has
  to *name both places*, which cost a real evening to learn. It used to say "Events stay on
  this device", which is true and useless: they reach the phone's own calendar, and that
  calendar is displayed by Samsung Calendar and Google Calendar alike, both of which sync to
  Google. So the events showed up in an app that syncs to Google and the obvious conclusion
  was that they had synced. They had not.
- **A question this app asks is a proposal, not an interrogation.** Every confirmation is
  already a yes/no — the actions are parked and `classifyConfirmation` replays or drops them
  without reaching the model, so the exchange is *free* — and it was nonetheless answered by
  typing the word "yes" into a text box, on the screen of an app whose premise is not having
  to. `answers: 'yesno' | 'open'` rides on the clarification, the sheet draws two buttons for
  the first, and a pending question no longer forces the keyboard up. Two traps: turning off
  the forced `setTyping` is not enough on its own, because the box also rendered on the mere
  *existence* of a clarification; and **No must not end the turn** — the useful answer to
  "Book it Thursday at 14:00?" is almost never "no" but "no, Friday", so it opens a short box
  with the question still on screen. RULES 4 in `prompt.ts` makes the model's own questions
  the same shape: propose the concrete thing and ask yes/no, never "When should I book it?",
  which answers a spoken sentence with a demand for a longer one.
- **The caption under the mic is a fixed box the words move inside.** It was one elided line,
  on the reasoning that a caption which grew would push the button out from under your thumb.
  The reasoning was right and the conclusion was wrong: a dictated sentence became "BOOK TWO
  HOURS FOR THE ROBOT…", so the one moment you most want to see what was heard was the one
  moment it was hidden. `CAPTION_HEIGHT` is reserved whatever is in it, so nothing moves, and
  a longer sentence scrolls with its top under a fade built from six 3pt bands —
  `expo-linear-gradient` is not a dependency and 18pt of decoration is not a reason to make a
  native module one. A live transcript also drops `eyebrow`: that variant is a tracked,
  upper-cased *label*, right for "TAP TO SPEAK" and hostile to a paragraph, and Android
  cannot measure `letterSpacing` correctly anyway.
- **Idle drifts too, at a speed you cannot catch.** The field used to breathe in place and
  move sideways only while thinking, which at a glance is a very large blurred circle sitting
  in the middle of the screen. What makes an ambient background read as expensive rather than
  as a static gradient is that it is never quite where it was — so `IDLE_DRIFT_MS` is 18
  seconds out and 18 back against thinking's 2.6, with a *wider* travel and a second, slower
  vertical component so the path is a figure rather than a line being retraced. The distance
  is not what keeps it calm; the speed is.
- **`thinking` is the state that most needs to look alive, and it was the quietest.** Both
  mics drew `ellipsis-horizontal` — three dots that never move — at the only moment the user
  has nothing to do but decide whether the app has stopped, and a still indicator is
  indistinguishable from a hung process. `ThinkingDots` is one clock with a per-dot phase
  offset, never three loops (independent ones drift apart within seconds and stop reading as
  one object), and it is hidden from screen readers because the caption and
  `accessibilityState.busy` already carry the fact. `HeatField`'s thinking core went 0.45 →
  0.72 on its own 2.2s tempo with the source riding up and down, still under `listening`:
  listening is the user acting, thinking is the app working, and an app that shouts louder
  than the person is the wrong way round.
- **A row on Settings has to justify being a question at all.** The old test was "could a
  stranger set this to a value that breaks the app" and it sent the dangerous knobs to
  `/developer`. That is still true and is not enough: the app is one microphone and one
  answer, and every switch in front of that is a decision taken before anything gets done.
  What is left is the plan, the disclosure of where words go, the one switch that lets
  anything leave the phone, the user's own data, and a colour that cannot be wrong. "Speak
  replies" went to `/developer` — off by default for the life of the app, and reunited there
  with the `ttsRate` slider it had been separated from, which meant anybody who turned
  speaking on could not reach the dial that makes it bearable.

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

## The day has a shape, and the calendar has to draw it

Redesigned 2 September 2026, because the screen you open to find out about your
day could not answer the two questions a day is made of.

`AgendaList` was a stack of cards with a time beside each. That says *what is
on*. It cannot say that nothing happens between 09:00 and 14:00 — two events
five hours apart looked exactly like two back to back — and it cannot say that a
class and a meeting **collide**, which the Today screen had been labelling CLASH
on the very same pair while the calendar sat silent about it.

- **One spine.** A continuous rule down the left with a node at each start, on
  the same centre line as the clock reading beside it. It is what makes the list
  read as one object rather than as unrelated cards; `Spine`'s `top`/`bottom`
  end the day on a node instead of trailing a line into empty ground.
- **`joinsOf()` in `agenda.ts` is the whole model, and it is pure.** For each
  item it says what sits above it: a `gap` worth naming, an `overlap`, or
  `butt`. Two things it gets right that an obvious version does not — it
  measures against the **furthest end seen so far**, so two meetings inside one
  long class both mark as clashing rather than the second clearing the moment
  the first ends; and an overlap is reported as *how much of the later thing is
  covered*, so a one-hour meeting inside a three-hour class is a one-hour clash,
  not the 2h 20m that measuring to the class's end produced.
- **Deliberately not to scale.** Five empty hours would cost five empty hours of
  screen, which is the whole reason an agenda beats a grid. A labelled gap is
  the same fact in one line. `GAP_FLOOR_MINUTES` is 45 — ten minutes between two
  lessons is not free time, it is the walk between rooms.
- **The card carries the duration and the end.** They were a second number in
  the gutter under the start time, which put two unrelated readings in one
  column. A start and a duration is arithmetic; a start and an end is a
  schedule.
- **An all-day event has no time, so it has no place on a time spine.** Its own
  band above the day. The gutter used to carry the words "all day" in a 46pt
  monospace *clock* column.

## Three views, and why a grid is not a longer agenda

Added 2 September 2026 alongside the agenda redesign. `calendar.tsx` is Day,
Week and Month; `AgendaList` is the first, `WeekGrid` and `MonthGrid` the other
two, and `grid.ts` is the layout model all of it shares — pure, so a block
appearing on the wrong day is a failing test rather than a screenshot.

- **They are different questions, not different densities.** The agenda spends
  pixels only on what is there, which is right for "what is next" and useless
  for "what does my week look like" — that one *needs* the empty space. Month
  answers a third: where in the month was the thing I half-remember.
- **`slice()` clamps to the day, so a 23:00–01:00 event appears on both.** A
  naive bucket by `startsAt` loses it from the second day entirely and Wednesday
  morning looks free. `continuesBefore`/`continuesAfter` are what let the face
  square the cut edge and round the real one.
- **Lanes are per *cluster*, not per day.** Two things at the same hour sit side
  by side rather than hiding one — a split lab group, a double-booked afternoon
  — but counting lanes per day would halve the width of every other block on
  that day because of one collision, with nothing on screen saying why.
- **Month is a grid *over the day it opens onto*.** Compact rows on top, the
  selected day's agenda underneath, and `onSelectDate` selects rather than
  navigates — the day it selects is already on screen. Sending somebody to
  another view to read a day they can see is the thing this layout exists to
  avoid. It is where Samsung, Outlook, Teams and Todoist all landed.
- **A month cell draws bars, not names.** At the height a grid can afford while
  sharing the screen with an agenda, a name is four truncated characters —
  worse than nothing, because it invites you to read it. The bar is this app's
  own heat cell at the size that fits. A day with more than fits shows only the
  first few and the cell does not say so; that is defensible *here* and would
  not be alone, because the full list is on the same screen and the
  accessibility label carries the true count.
- **`ROW_HEIGHT` is fixed, not shared out.** The agenda takes the remainder, so
  a month that grew to fill the screen would push the day off it — and a
  five-row April would put the agenda 46pt higher than a six-row February,
  which reads as the screen shifting under your thumb between months.
- **No weekend wash in the month.** At a 46pt cell it draws a tall rounded
  rectangle behind an empty Saturday and reads as a placeholder card. The week
  grid, whose columns are 600pt tall, keeps its: the same paint at a different
  size is a different thing.
- **Paging arrows go together, and never beside the back button.** They were
  either side of the month label, which put "go back" and "previous month" as
  **two identical chevrons a finger's width apart** at the left edge — logical,
  and the first thing a real user objected to. Every phone calendar checked
  pairs them on the right; none puts one next to the navigation back.
- **`calendarView` is a setting, not screen state.** Somebody who thinks in
  weeks thinks in weeks every time they open it. It is also the only way to
  reach the grids on a simulator, which has no way to tap a segmented control.
- **Both grids reserve the mic.** The week's scrolls, so `MIC_CLEARANCE` is
  enough. The month does *not*, so it takes a real bottom inset — without it the
  bottom-right cell of every month is a day you cannot tap.
- **41pt of text per column is the whole typographic constraint.** Seven columns
  of a 402pt phone, less the rule and the padding. "Physics" is 41.9pt at
  `micro`'s 11 and 37.9 at 10, so the block face is 10 and one line, truncated —
  the same conclusion the curriculum grid reached, for the same reason. And the
  header label goes short (`Sep 2026`, 108.7pt) whenever the paging chevrons are
  on, because "September 2026" is 191.8 against a 148pt slot and silently became
  "September 2…".

The same defect, elsewhere: **the briefing's lead column is 52pt and Martian is
13pt**, so `14:00` fits and nothing else does. It was being handed
`14:00–17:00` (97pt), `Overdue`, `Someday`, `You owe`, `Owes you` and `All day`
(61.8pt each) and rendering `14:0…` and `Over…`. That column takes a clock
reading now; a word goes to the meta line in the row's own tone, and `dueLead()`
returns one or the other rather than a string that could be either.

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

**One left edge per screen, and it is the gutter.** Two rules, both of which
were broken by putting a control in the same flex row as the text beside it:

- **A screen's controls get their own row, above the title.** `Screen` holds
  `back`, `right` and `close` in a 40pt row and the heading under it, and that
  is why: beside the title a 26pt chevron plus the row's gap pushed every
  heading in the app to **47pt** while the body under it — every card, every
  section label, every list row — sat at the 16pt gutter. `Menu`, which has no
  chevron, kept its title at 16, so there were two left edges on a screen and a
  third between screens. `back: marginLeft: -8` was an attempt at exactly this
  and could never have reached: the glyph is wider than the gutter it was being
  pulled into. On its own row that -8 is worth what it was meant to be — a
  chevron carries its own left bearing, so pulling the *box* out by 8 puts the
  *ink* on the gutter. **`BackControl` is the only bare back chevron**; three
  screens had hand-rolled 24pt ones with 8 and 12pt slops, and one of them
  answered an empty stack — which is what a widget or a notification opens a
  note with — by doing nothing at all.
- **A row's optional lead reserves its column, and so does everything beside
  it.** `ReserveRowLead` does the first for `Row`; `useRowLeadInset()` does the
  second, for the things in a card that are not rows. Developer's Assistant card
  is a row, a `MODEL` heading with chips, two sliders and three more rows, and
  only the rows knew about the column: labels at 64pt, everything between them
  at 29. The same defect one level in.

**`alignSelf` on a child beats `alignItems` on its parent, and the cross axis
is not the axis you think it is.** `Button` sets `alignSelf: 'flex-start'` so a
button stacked in a *column* hugs its label instead of stretching to full
width. On a **row** that same declaration addresses the vertical and means
"hug the top" — so a row that says `alignItems: 'center'` gets a centred icon
and a top-pinned button. Profile shipped like that: `Change` level with the
title of a six-line row, a hand's width of empty card beneath it, beside an
icon that was correctly centred. There is no direction-agnostic way to say "do
not stretch" in flexbox, so `Button` cannot fix this for itself — **only the
caller knows which axis it is on.** `Row`'s `right` is a wrapper `View` for
that reason (it restores a column context, so the Button's `alignSelf` means
the horizontal thing it was written to mean); the message-and-retry rows say
`centreOnRow` explicitly. `row-alignment.test.ts` holds both.

The same shape, trailing: **a conditional icon at the end of a row moves every
badge in front of it.** `AgendaList` drew a 13pt kind glyph only on classes and
travel blocks, so the CLASH badge on a plain event sat 21pt further right than
the one above it — two identical warnings in one list, not sharing a column.
The row already did this correctly for its leading dot (`dotGap`); reserve the
slot, always.

**Measure it, do not look at it.** Two of the "misalignments" found by eye in
this pass were the screenshot's own scaling — the ledger's amount column is
right-aligned to the pixel and the settings trailing buttons share a 28.8dp
inset. `notes/measure.py runs <png> <y0> <y1>` prints the ink spans across a band in
device points. And when a label does not fit, measure the *font*:
`notes/measure.py fits Physics Robotics --size 11` loads the shipped `.ttf` and
answers "Physics" in 41.9pt at `micro`
against a 45pt week-grid column — which is how the curriculum grid stopped
trying to wrap and started truncating, there being no font size at which
"Robotics", "Chemistry" and "Mathematics" all fit.

**The app mark is the day strip, and `scripts/icons.py` is the only place it
exists.** Five heat cells with the fourth burning — the same primitive every
widget face is built from, at the same four levels the payload travels in — so
the icon and a placed tile are visibly one object. One file owns the geometry
and cuts all six PNGs plus the SVG masters from it; editing `assets/*.png` by
hand puts them back out of step, which is the state they were inherited in (a
blue chevron on pale blue with its construction guides still showing, the one
thing in the product that disagreed with its own palette). The Android
foreground is scaled to clear the adaptive icon's *66dp guaranteed* circle
rather than its 72dp visible one, and the monochrome layer survives being
flattened by the themed-icon engine because the fourth cell is taller, not only
hotter.

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
| bare `RefreshControl` | `useRefresh()` | `tintColor` is iOS-only, `colors` Android-only — **and it is a hook, not a component.** `ScrollView`'s `refreshControl` is cloned with internal props by the native view manager, so a *wrapper* component there receives none of them and the whole list renders blank on Android with nothing logged anywhere. Three screens shipped like that. Hoist `const refreshControl = useRefresh({...})` above the return and pass the element. |

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

## What the app counts about itself

Added 1 September 2026, reversing a decision recorded in `notes/HANDOFF.md` — the full
two-layer design was already written at `notes/ONBOARDING-SPEC.md` §13–15 and this is
that spec executed. Two layers, and the distinction between them is the whole thing.

- **Layer 1 is local and always on.** `app_events` (migration 6) through
  `src/repositories/appEvents.ts`, a ring pruned on every write to the newer of 90 local
  days or 5,000 rows. It is the user's: `db/wipe.ts` erases it — unlike `llm_usage`, which
  is the *operator's* meter and is preserved — and it does not travel in a backup, because
  somebody else's counts restored onto your phone are noise, and a file that could write
  this table could be edited to fake a funnel. Both distinctions are asserted.
- **Layer 2 is off.** `analyticsOptIn` defaults false. `upload.ts` posts to the operator's
  own backend and is inert without `EXPO_PUBLIC_RIDIK_API_URL`, the same capability-detected
  shape as `liveActivity.ts`. **Layer 1 is complete without it** — that is what makes
  "Export usage" a real answer for beta testers with nothing on a network.

Three things that will bite:

- **The vocabulary is the privacy boundary, not the storage layer.**
  `src/services/analytics/events.ts` is a zod discriminated union with **no free-text
  property anywhere in it** — every field is an enum, a bucket or a small integer, every
  `props` is `strictObject` so an unknown key is a refusal rather than a silent trim, and
  `vocabulary.test.ts` reads the file *as source* and fails on a property name that looks
  like content or on any `z.string()` at all. `tool.name` is allow-listed by exact line
  because it is the app's own `ToolName`, never a word anybody said.
- **There is exactly one instrumentation point for a turn.** `audit()` in
  `src/llm/orchestrator.ts` is where all five return paths converge, so `count()` sits
  beside it and the ledger is complete by construction rather than by every call site
  remembering. It goes through the injected `repos`, never through the `services/analytics`
  facade, or the orchestrator's own dependency injection breaks and its tests with it.
- **What the Usage screen shows is what would be uploaded, byte for byte.**
  `appEvents.unsent()` returns the payload shape — no row id, no `created_at`, the local
  date is the finest time that travels — and `upload.ts` does not reshape it. Reshaping it
  anywhere would make that screen a decoration instead of a disclosure, which is the only
  reason it is defensible to upload at all.

Crash reporting is `services/analytics/crash.ts`: Sentry, behind the same single switch,
with breadcrumbs, screenshots, view hierarchy, tracing and Sentry's own `user` all off. It
initialises **late**, after the person has been asked — so the earliest crashes go
unreported, and that is the correct side of the trade rather than an oversight. No DSN has
ever been set, so it has never sent anything.

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

## Offline mode is real, and this is exactly what it does

Audited 17 August 2026 by running `fallbackInterpret()` against real phrases,
because "there is an offline mode" is the kind of claim that rots into a dead
branch nobody has executed in a year. It had not rotted. `src/llm/provider/mock.ts`
is a genuine pattern matcher, and it is what makes three separate promises true:
declining consent leaves a working app, a spent trial leaves a working app, and
an install with no key is still worth opening.

Five behaviours, verified:

| Said | Filed |
| --- | --- |
| "remind me to call Ivo at 4" | `calendar_add` — title "Call Ivo", the next 16:00, kind `reminder` |
| "spent 12 on lunch" | `ledger_add` — amount 12, category "lunch" |
| "add milk to my shopping list" | `checklist_add` — list "shopping", items ["milk"] |
| "find the wifi password" | `search` — query "wifi password" |
| anything else | `note_create`, with the sentence as a bullet |

The last row is the important one. **Nothing said offline is ever discarded** —
an utterance it cannot parse becomes a note rather than an error, so the words
survive to be dealt with later. That is the same principle as `recovered` in
`store.ts`, applied to comprehension rather than transport.

Two things that look like bugs and are not:

- **The search branch returns no `conversational_feedback`, deliberately.**
  `composeFeedback` prefers the model's sentence over the executor's, and for a
  search the executor's sentence *is* the answer — "Found 3 matches for
  'resistors'". A canned "Searching (offline)." would spend the one honest tag
  this engine has on withholding the thing that was asked for.
- **"cancel my dentist appointment" becomes a note, not a cancellation.** The
  offline engine never guesses a destructive action. Saving the words is the
  correct degradation; deleting the wrong event is not.

What it deliberately cannot do: multi-intent (one utterance, one action), any
resolve against existing rows beyond a list name, and anything the model's
judgement is for — scheduling inference, travel blocks, dependency chains. The
turn carries a `notice` saying the assistant is offline, because a silently
dumber assistant is the failure `LastAction` exists to prevent.

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
- **A hook below an early return is a crash you cannot see.** Half the screens in this app return a
  skeleton while a query is in flight, and every one of those returns is a fork in the hook order:
  a `use…()` placed after it runs on the second render and not the first, which React refuses with
  "Rendered more hooks than during the previous render". Three things then conspire to hide it. The
  crash needs the *transition*, so it only happens where the data is genuinely async — a device, not
  a test with a resolved mock. `ErrorBoundary` turns it into a small failure card rather than a
  redbox, so the screen still looks like a screen. And a mocked hook that calls no hook of its own
  makes the counts match, so a test written for it passes anyway — `settings-screen.test.tsx` has
  `useTrialLedger` calling a real `useRef` for exactly that reason, and says so.
  `PlanGroup` lost this way and nobody noticed for weeks: the one row that tells a free user their
  trial is finite was replaced by a failure card on every single launch. Put every hook above every
  return, and when mocking a hook, mock it *as* a hook.
- **`pod install` needs a UTF-8 locale on this machine.** CocoaPods 1.17 on Ruby 4.0 throws
  `Unicode Normalization not appropriate for ASCII-8BIT (Encoding::CompatibilityError)` and a
  twenty-line Ruby backtrace naming `Pod::Config#installation_root`, which looks like a broken
  CocoaPods install. It is the locale: `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`. The
  failure then cascades — no `Podfile.lock`, no `ios/Ridik.xcworkspace`, and `xcodebuild`
  reports only that the workspace "does not exist", which is the error you will actually see.
- **A native dependency's build phase can fail the whole iOS build long after the JS is fine.**
  `@sentry/react-native`'s plugin adds a source-map upload phase that runs `sentry-cli`; with
  no organisation configured it fails with `An organization ID or slug is required` around line
  9,158 of the log, after `Bundle React Native code and images` has already succeeded. The
  answer is the same capability detection everything else here uses: `app.config.ts` adds the
  plugin only when `EXPO_PUBLIC_SENTRY_DSN` is set, so a build with no Sentry account has no
  upload phase at all.
- **`expo prebuild --clean` deletes `android/local.properties`.** Gradle then fails with
  "SDK location not found", which reads like a broken toolchain rather than a missing generated
  file. Rewrite it after any clean prebuild:
  `echo "sdk.dir=$HOME/Library/Android/sdk" > android/local.properties`.
- **`ERR_NOTIFICATIONS_KEYCHAIN_ACCESS` / `-34018` on the iOS simulator is not a bug.** `-34018` is
  `errSecMissingEntitlement`, and these debug builds are made with `CODE_SIGNING_ALLOWED=NO` —
  entitlements are embedded during signing, so an unsigned binary has none and any keychain access
  group is unavailable. It is `expo-notifications` reading its own Expo-push server registration,
  which this app never asks for — there is no remote push at all — and which nothing in `src/` calls. The app's own
  SecureStore usage is unaffected and a signed build has neither problem. It cannot be fixed by
  adding the entitlement, because an unsigned build applies no entitlements at all.
- **The Android emulator here has no network route.** RevenueCat then logs a wall of
  `Unable to resolve host api.revenuecat.com`. That is the emulator, not the app — and the app's
  answer to it is worth looking at rather than scrolling past: the entitlement resolves `UNKNOWN`
  and the Plan row says "Could not reach the store. Your plan is unchanged", which is the
  four-state invariant in `allowance.ts` doing the exact job it exists for. A wall of red there is
  a passing test of it.
- **RNTL v14 is fully async.** `render`, `rerender`, `unmount` and `fireEvent` all return promises.
  An unawaited one leaks an `act()` scope into the next test and every query there returns nothing.
  `rerender` also replaces the **entire** tree with what you hand it, so re-rendering a screen
  needs the providers wrapped round it again — a bare screen fails as "No QueryClient set", which
  names nothing to do with the thing under test.
- **`drizzle-orm/expo-sqlite` must be imported from `/driver`.** The package index also exports
  `useLiveQuery`, which pulls in the native module and makes the file unloadable under Node.
- **Gestures inside a React Native `Modal` need their own `GestureHandlerRootView`.**
  A `Modal` is a separate native window, and gesture-handler only routes touches inside a root
  view — so a `GestureDetector` in a modal registers fine and then silently never receives
  anything. There is no warning; the gesture just does nothing.
- **The recogniser talks after it is stopped.** Cancelling usually surfaces as an error a moment
  later, which would land on a store the user has already dismissed and leave the mic red with a
  message nobody can read. `store.ts` guards every callback with a session ticket; a late
  transcript must not be executed either. **And it says goodbye as an error.** A Galaxy S23
  fires `ERROR_CLIENT` — `code: 'client'`, "Other client side errors." — *after* delivering a
  complete, correct final result, so every dictation on that phone ended as "Speech recognition
  failed." over a transcript that was perfect, and no turn ever ran. That one arrives for the
  session that is still current, so the ticket does not catch it. `handleError` in
  `src/voice/stt.ts` settles on `client` **when there are words to settle with** and keeps it an
  error when there are none: a client error over a microphone that genuinely never started is a
  failure, and reporting *that* as silence swaps one wrong message for a quieter one. The code was
  invisible for as long as it took to add one `log.warn` — `toSttError`'s `default` arm turns every
  unmapped code into the same sentence, so logcat had nothing at all about it.
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
xcrun simctl launch booted ai.dby.ridik
xcrun simctl io booted screenshot /tmp/shot.png

# Android
adb reverse tcp:8081 tcp:8081
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n ai.dby.ridik/.MainActivity
adb logcat -d -s ReactNativeJS -s AndroidRuntime
```

A change is not verified until it has run on both.

**And a green log is not a running app.** A release APK carrying a RevenueCat
Web Billing key (`test_`, `rcb_`) booted its JavaScript completely — `database
ready`, `push ready`, `background work registered`, no `ClassNotFoundException`
— and *then* the native SDK put up a "Wrong API Key" dialog and killed the
process. A logcat check passed for six days while the artefact could not be
opened. `apiKey()` refuses a foreign key now, but the lesson generalises: the
native side can kill a process after the JS side has reported success.

So every verification ends with two things a log cannot give you:

```bash
adb exec-out screencap -p > /tmp/shot.png   # LOOK at it
adb shell pidof ai.dby.ridik                # empty means it died
```

Same on iOS: `xcrun simctl io booted screenshot`, and check the process is still
there. Screenshot after the state you care about, not just at launch.

**There is no `adb shell input tap` for the iOS simulator.** `simctl` can boot,
install, launch, `openurl` and screenshot, and that is the whole list — nothing
in it touches the screen. So anything behind a tap (a paywall card, a purchase
dialog, a confirm) is reached one of three ways:

- `xcrun simctl openurl booted 'ridik:///plans'` for navigation. **Terminate the
  app first.** Sent to a *running* app the URL raises an "Open in Ridik?" system
  alert that then needs a tap, which is the problem you were avoiding; a cold
  launch routes straight there with no prompt.
- Seed the state in SQLite. The database is at
  `$(xcrun simctl get_app_container booted ai.dby.ridik data)/Documents/SQLite/ridik.db`
  and `app_settings` holds JSON-encoded values, so consent becomes
  `insert or replace into app_settings values('assistantConsent','"granted"',<ms>)`.
  Terminate first — the app holds the WAL open.
- Clicking through AppleScript, for what neither of those reaches. **Do not
  compute the mapping from the window frame** — the arithmetic that used to be
  written here (`×(window_width / device_width)`, so `×1.134` on an iPhone 17
  Pro) is wrong, because the window includes a title bar and side padding the
  ratio does not know about. Ask for the frame instead: the window's `AXGroup`
  child *is* the device screen and it is reported at **1:1 in device points**,
  so a point maps as `group_origin + point` with no scaling at all.

  ```
  osascript -e 'tell application "System Events" to tell process "Simulator" \
    to get {name, role, position, size} of every UI element of window 1'
  ```

  The `AXGroup` with a size matching the device (402 × 874 for a 17 Pro) is the
  one; click with `tell application "System Events" to click at {x, y}`.

  Two things about the permission. It is **Accessibility**, and it must be
  granted to the app that owns the shell — for an agent running under Claude
  Code that is `com.anthropic.claude-code`, at
  `~/Library/Application Support/Claude/claude-code/<version>/claude.app`, and
  **not** `/Applications/Claude.app` (`com.anthropic.claudefordesktop`), which
  is the one it looks like it should be. The path is version-pinned, so it
  needs redoing after an update. Process listing through System Events works
  without the grant, which makes it easy to think you have it when you do not —
  the test is a UI-element query like the one above.

  Note the older claim that "the simulated app exposes no accessibility tree" is
  still true of the *app's* own views, and irrelevant here: the enumeration
  above walks the **Simulator's** window chrome, which is a normal macOS app.

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

One payload, fourteen faces per platform, plus an iOS-only Lock Screen set.
`src/services/widgets/snapshot.ts` builds it; everything
a widget draws is computed there, where it can be tested under plain Node, because neither
WidgetKit nor an `AppWidgetProvider` can run this app's JavaScript or open its SQLite file.

Four numbers have to agree across four files, and nothing fails loudly when they do not:

| What | Where |
| --- | --- |
| `WIDGET_SNAPSHOT_VERSION` | `snapshot.ts`, `SnapshotStore.supportedVersion` (Swift), `WidgetSnapshot.SUPPORTED_VERSION` (Kotlin) |
| `PLOT_HEIGHT` | `PLOT_HEIGHT` in the Android plugin, `plotHeightDp()` in `RidikRowsFace.kt`, the `height:` on each `Ridik*View` in `RidikPlotViews.swift` |
| `FOCUS_CELLS` = 16 | `snapshot.ts`, `WidgetSnapshot.FOCUS_CELLS` (Kotlin), `FOCUS_SLOTS` in the Android plugin, `SessionStrip.slots` (Swift) |
| `ROW_CAP` = 6 | `snapshot.ts`, `RidikRowsFace.ROW_SLOTS`, `ROW_SLOTS` in the Android plugin |
| `LIST_ROW_CAP` = 11 | `snapshot.ts`, `Slots.listRows` (Kotlin), `LIST_ROW_SLOTS_BY_SIZE` in the Android plugin |
| `MEDIUM_MIN_DP` = 250, `RAILS_LARGE_DP` = 360 | `RidikCells.kt`, the Android plugin's `resizeFloor` / `resizeCeiling` |

**`ios/` is generated, so editing `targets/` and building compiles the old
file.** `targets/RidikWidget/` is the source of truth and what is committed;
`@bacons/apple-targets` copies it into `ios/RidikWidget/` at prebuild, and the
Xcode project's file references point at the *copy*. `xcodebuild` never reads
`targets/`. Four faces were fixed there, the widget scheme built clean —
**BUILD SUCCEEDED, zero errors** — and the tile did not change by a pixel,
because the build had faithfully compiled months-old copies. A green build is not
evidence that your edit was compiled. Re-run prebuild, or
`rsync -a targets/RidikWidget/ ios/RidikWidget/` for a fast loop;
`src/ui/__tests__/widget-target-sync.test.ts` fails when the two drift and skips
when `ios/` is absent.

**A widget face can be rendered on real iOS with no tapping at all.** These are
plain SwiftUI views, so they compile for the simulator SDK as an ordinary
executable and run *inside* the simulator, where `ImageRenderer` rasterises them
against real iOS metrics and SF Symbols:

```bash
xcrun -sdk iphonesimulator swiftc -target arm64-apple-ios18.0-simulator \
  -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" -o bench src/*.swift
xcrun simctl spawn booted ./bench /tmp/bench    # writes PNGs to the HOST /tmp
```

`notes/tilelab` is that bench, and it renders **every face at every size its
`Widget` declares** — 58 PNGs, light and dark, in about a second. It is the only
way to *see* a face without placing one by hand: `simctl` has no tap, touch or input subcommand at all, the simulated
app exposes no accessibility tree, and driving the widget gallery by desktop
coordinates was tried and abandoned — the window has a title bar the obvious
arithmetic misses, and a mis-aimed tap silently launches Calendar instead.

**The picker inflates a preview at the tile's declared size, on a grid that is
not yours.** Three separate defects came out of forgetting that, and all three
were invisible on the machine they were written on:

- **`previewSize` must be the largest size the face declares.** Now/Next
  declared `['medium', 'large']` and previewed at `medium`; a 4 x 2 tile clears
  `LARGE_MIN_DP` on every phone, so the card carried a medium composition in a
  large box and the weighted spacer took the difference as one dead band across
  the middle of it. `widget-resize.test.ts` now asserts the rule for all
  fifteen.
- **A preview is one frozen layout, so it has to be built for the *smallest*
  box it will ever be inflated at.** The live faces do not have this problem —
  `drawRows` reads the launcher's own options per widget id — but the preview
  cannot adapt, so filling it to the *large* row cap sliced the last row in half
  on a 360dp grid. Air on a big phone is a worse-looking widget; a row cut
  through the middle is a broken one, and the second is what a stranger decides
  on.
- **`minHeight` does nothing to a weighted child.** `LinearLayout` measures
  those with an `EXACTLY` spec and `minHeight` only ever applies to `AT_MOST`
  or `UNSPECIFIED`. A 14sp plate numeral in a row compressed below 14sp is not
  shrunk and not clipped — it is drawn centred, past its own cell, into the
  weeks above and below, so a compact grid rendered August as five rows of
  digits on top of each other. `autoSizeTextType="uniform"` is what actually
  scales it; `minHeight` was tried, generated into all six rows, and changed not
  one pixel.

The compact profile that found all three is one command, and it is worth running
before believing any widget change:

```bash
adb shell wm size 720x1600 && adb shell wm density 320   # a 360dp phone
adb shell wm size reset && adb shell wm density reset
```

**A launcher will stretch a tile as far as you let it, and `maxResize*` is how
far.** Every provider shipped `800dp`, which is no ceiling on any phone. The
plots pin their own height on purpose — `plotHeightDp` draws Sundial's arc at
128dp whatever the tile measures, because these faces size every ornament from
their own box and a taller box draws a *different* picture rather than a bigger
one — so a Sundial dragged to 359dp tall was a 128dp arc with 200dp of bare
ground under it. `resizeCeiling` in the plugin now derives the ceiling from
`cells` the way `resizeFloor` derives the floor: 110dp a cell against the
floor's 55, both wrong in the safe direction, with two cells of headroom only
where a `large` layout exists to use it. Habits is the exception and is marked
`rails: true` — `railsSizeOf` promotes on *width*, so its ceiling is a width
held below `RAILS_LARGE_DP`. Note that Android never resizes a tile already on
a home screen: a ceiling only binds new placements and the next drag.

**A tile clips in silence, so a face's height has to be added up rather than
eyeballed.** Four faces shipped overflowing their own box — Rings, Route, Week
and Now/Next — and not one of them logged, warned or failed a test. What goes
missing is whatever the layout put last, which is why it reads as anything but a
layout bug: Week silently lost its entire date row, Rings and Now/Next lost their
*headers*, so the tiles were reporting on a day they no longer named. A medium
tile's content box is **312 x 130** points after WidgetKit's own inset, and 130
is the whole budget for header, graphic, caption and any empty-state sentence
underneath. Rings was asking for 189 of it.

`notes/tilelab` renders every face at that exact box in about a second, which is
the only way to see this without placing a widget by hand — `simctl` cannot touch
the screen and an `adb` long-press cannot be simulated. Three traps are written
up in its README, and **all three are the bench lying rather than a face being
wrong**, which is the failure mode to fear here: the fix for an invented defect
is a real regression.

- `widgetFamily` has no setter and `previewContext` does not populate it, so
  "small" renders are silently medium views in a small box unless the bench
  patches its own copies.
- **macOS's `Link` cannot host a `Text(Image(systemName:))`** and draws the
  missing-symbol placeholder instead. Every medium and large face showed a
  yellow ⃠ where the microphone belongs — eighteen tiles, every one of them
  correct on a device. `harness.swift` shadows `Link` with a module-local
  passthrough.
- `containerBackground` paints nothing outside a widget host, so the ground is
  a copy and can drift.

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
- ~~The LLM path has only run against the mock provider~~ — no longer true, and the entry stayed
  after it stopped being true, which is the worst state for an honest-gaps list. Real requests were
  made against the live API on 16–17 August 2026: that is where the *decision to pin* came from —
  the shipped alias `gemini-flash-latest` resolved, on the first real call, to
  `modelVersion: gemini-3.7-flash` rather than the Flash-Lite every figure in the plan assumed, so
  `DEFAULT_GEMINI_MODEL` is now the explicit `gemini-3.1-flash-lite` and `gemini.ts` carries the
  arithmetic. Read the short version as "3.7 Flash is what we were accidentally buying", never as
  what is pinned today
  and where the schema-ladder table in `settings.ts` was measured — eight representative utterances
  per rung, which is what proved rung 0 gets HTTP 400 on every request and rung 1 answered 7 of 8
  turns with an empty `parameters: {}`.
  What is *still* unproven is narrower and worth keeping separate: those calls were driven by a
  harness rather than by a turn through the app, so the pipeline's own path to the provider —
  consent gate, budget, keychain read, executor — has never carried a live response end to end on a
  device. Paste a key at Developer → Assistant key and say one sentence, and that gap closes.
