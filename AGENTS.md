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
- **`formatRelative` and `formatDayHeading` defaulted to `Date.now()`**, which is
  the invariant above broken inside `src/core/time.ts` itself — so a note row, the
  places screen, the people list and two lines on a person's profile rendered a
  string no frozen clock could reach. Both default to `now()` now. The parameter
  stays: a caller with a `useNow()` tick should keep passing one, because that is
  what re-renders the label as time moves and a default cannot.
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
  **The one network call that is deliberately not on that list** is the
  on-device speech model download in `modules/ridik-speech` (`AssetInventory`).
  It is a *model* coming down, not a recording going up: nothing the user has
  said, or has ever said, is part of the request, so there is no recipient of
  their data to name. It therefore runs on the `onDeviceOnly` path too — and
  that is the point of it, because before it a declined-consent iPhone with no
  dictation model got `NO_OFFLINE_VOICE_MESSAGE` and no way forward. If a future
  path sends anything *of the user's* to fetch something, it is a recipient and
  this exception does not cover it.
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
- **One gate reads the words; every other one reads the reply — and it now fires only when
  the recogniser is unsure.** It is still the only check in this app that runs before the
  model is called: `confirmMode`, the executor's review gate and the handlers' own questions
  all read actions a reply proposed, so by the time any of them can ask, the request has been
  made and billed. A recogniser that heard "doctor" for "tutor" is one keystroke here and a
  whole turn of somebody's allowance anywhere else; on a free install that turn comes out of a
  *lifetime* trial and does not come back.
  **What changed, 12 September 2026.** It used to fire on *every* utterance — the words went
  into the composer behind a full-screen scrim and the user pressed Send, on the one screen
  whose whole premise is not having to look. Measured: two taps and an extra surface for a
  clean sentence, three and the sheet twice for 24 of the 29 write tools. That charged every
  sentence for the mistakes of a few. `onFinal` now sends unless `wasPoorlyHeard` says the
  transcript is borderline — the app's own existing answer to "are these the words you said",
  at the same documented 0.85 the confirmation gate uses, and already careful that Android's
  0/-1 means *unmeasured* rather than bad (the other reading would stop every write on that
  fleet for ever).
  **The reading did not go away; it moved.** The caption under the microphone *is* the live
  transcript, and what commits is ending an utterance the user has been watching the whole
  time — the same trade the Stream ring makes by having no screen to put a draft on at all.
  What is still protected: `confirmMode` still asks before irreversible writes, so what was
  removed is the *second* ask, not the safety net.
  **It is still not a setting.** Conditional on confidence is not the same as configurable:
  there is nothing a user or a pipeline can set to change it. It shipped as a switch for an
  afternoon and the switch was deleted the same day, because the two halves are not
  symmetrical — sending is one tap and unsending is not a thing that exists. There is no
  "rewind my last request": `LastAction` undoes a *single* row through an allow-list, so one
  mis-heard sentence that filed three actions is three separate corrections, some of which
  (`note_create` upserts, `habit_log` reports the habit) cannot be made at all.
  `review.test.ts` asserts there is no seam to configure it through, and
  `settings-screen.test.tsx` asserts there is no row.
  **Going further needs `undo` widened first.** Dropping `confirmMode` too — the fully
  Sandbar-shaped version, where every correction happens after the fact — is only honest once
  the receipt can actually take those writes back, and that is executor work, not a list edit:
  `habit_log` would have to report the log entry rather than the habit, and `note_create`
  would need the pre-upsert state. Until then the question before is what stands in for the
  undo after.
  **`sending` exists because the gap was drawn as `idle`.** The recogniser is allowed
  `STOP_GRACE_MS` (2.5s) to return a final result after being asked to stop, and for all of it
  the store used to say `idle` — so lifting a finger put the resting caption back over a
  sentence still being read, cooled `HeatField`, and a receipt then arrived from nowhere.
  Nothing was wrong except what the screen said. Anything that maps `VoiceStatus` needs an
  entry for it: `FIELD_STATE` in `app/index.tsx`, `CAPTION`/`SPOKEN` in `HomeMic`, and the
  dock's own heading, which off home is the only report the session gets.
  Three things it must not become: it is not a failure (no `recovered`, no error status —
  those are for a sentence that was *lost*, and reporting a success as a loss is what the
  `reason` on `DraftSeed` exists to prevent, copy included); it must not put a database read
  in front of the microphone opening, which is why nothing is read at all any more; and it
  swallows a **clarification answer** too, which still has to carry its pending token — a
  spoken answer that arrives bare turns the second half of a two-part turn into a first half.
- **An utterance is part of a conversation, and for a long time none of them were.**
  `historyFor` in the orchestrator built history for a *pending clarification*
  and nothing else, so two sentences twenty seconds apart were two unrelated
  first turns. That is the thing that stops free speech working, because nobody
  talks in self-contained commands: "add flowers to my list" then "toilet
  paper" is one thought, and the second half names no list, no verb and no
  destination. Filed alone it became a note nobody looked at again.
  `src/llm/recall.ts` is the window — the last `RECALL_TURNS` (6) inside
  `RECALL_WINDOW_MS` (10 minutes), read from `llm_interactions`, which has
  recorded every turn since the orchestrator was built and cost nothing new to
  store. They ride as `history` **outside** the system prompt on purpose: that
  prompt is the cached prefix and is byte-identical between turns so a provider
  can discount it, and recent turns change on every utterance.
  **The model line is what was *written*, not what was proposed.** The user says
  "my list" and the executor writes "Shopping"; a continuation has to land on
  *Shopping*, and the executor's own summary is the only place that name exists
  — the parameters still say "my list" and would start a second, near-duplicate
  list. So each turn travels as the spoken sentence plus a bracket of the rows
  that actually applied.
  Two things that bit. The obvious `row.createdAt < now` guard — to stop a turn
  appearing in its own history — **guards nothing**, because `audit()` writes at
  the *end* of a turn, and it breaks under a frozen clock, which is what every
  test here runs under; it silently dropped the whole window. And the pending
  pair **replaces** its own audit row rather than following it: both describe
  the same exchange and each has half of it, the row holding the sentence that
  was spoken ("I need a time first.") and the envelope holding the question that
  was actually asked ("Book it tomorrow at 10:00?"), which is stored nowhere
  else and is the only one the reply answers.
- **Nothing spoken is thrown away, and the online path was the dumber of the
  two.** RULE 18 in `prompt.ts` used to end "return an empty actions array and
  say so" for *anything* the model had no tool for — so somebody thinking out
  loud at a voice-first app got an apology and no record, while
  `provider/mock.ts`, the *offline* engine, had always kept those same words as
  a note. A question and a statement are different shapes and only the first was
  ever out of scope: a question it cannot answer from CONTEXT still gets no
  actions and one short honest sentence, and a statement — something that
  happened, a plan, a fact, a feeling somebody is turning over — is captured
  with `note_create` in their own words. The scope boundary itself did not move.
  Its companion is **RULE 16, the instruction is not the content**: "write that
  down", "note that", "save that" are directions about the *rest* of the
  utterance and must not survive into the row. Filed verbatim, "the L train
  isn't running this weekend, write that down" produced a note whose only bullet
  was that whole sentence, instruction included — which is what you find weeks
  later and cannot tell from a quotation.
- **Home's bottom is one panel with two sides: Said and Kept.** `HomePanel` —
  the conversation still inside the recall window, or the most recent notes,
  with a toggle between them. Notes were behind the menu, which is right for a
  screen you *go to* and wrong for the thing this app mostly produces: after
  RULE 18 almost every utterance that is not a command lands there, so "where
  did that go?" was answered by a hamburger, a sheet and a list.
  **Which side opens is not remembered, and that is safe because of what is
  outside the panel.** `LastAction` is the receipt for the newest turn, it sits
  below the box, and neither side can hide it — so the thing that must not be
  missed never depends on which tab is showing, which leaves the panel free to
  open on whichever side is useful: the conversation while one is happening,
  the notes the rest of the time. A manual pick wins until the side it chose
  empties out.
  **The toggle is drawn only when it has two sides, and its row is reserved
  either way.** One reachable option is not a choice. But the control comes and
  goes on a *ten-minute* boundary, and the stage is `flex: 1` and centres the
  mic, so anything appearing down here takes half its height off the top of the
  microphone: measured at **y=1198 with the toggle and y=1256 without**, a 19pt
  drift nobody could connect to anything they did. `TOGGLE_ROW` is 35 and is
  held whether or not there is a toggle in it — which is the rule home is built
  around, kept for the cost of an invisible gap over a gradient.
  **The two sides read in opposite directions, so the scroller is keyed on the
  side.** Said is oldest-first and ends at the receipt, Kept is newest-first and
  starts at the top. They share one `ScrollView`, so switching used to carry the
  offset across and land you in the notes mid-list with the newest title clipped
  off. `key={side}` remounts it; four rows is the cheapest correct fix.
- **What the user can see is what the model can see.** The Said side of
  `HomePanel` draws the same window `recall.ts` sends, from the same two
  constants. That is
  the design and not a coincidence: a fragment works *because* the turn above it
  is still in play, so the honest way to show that is to put the turn above it
  on the screen, and when the window lapses both go at once — the model stops
  carrying the conversation and the screen stops claiming there is one. It is
  also what keeps it off a resting screen, which matters because the example
  sentences that used to live in that slot were removed for being permanent
  furniture and a scrolling wall of everything ever said is the same mistake
  with more words in it.
  The newest turn is **not** in it — that is `LastAction` below the panel, which
  has the tick, the undo and the announcement — and nothing in the conversation
  is tappable, because the audit row keeps the parameters the model *sent*
  rather than the href the executor computed, and deriving a route from a tool
  name is how a tap lands on the one screen the row is not on. The Kept side
  *is* tappable: a note has one address and the row knows it.
  **It paints its own ground, and it has to.** Measured on a device: the quiet
  line came out at **2.68:1 near the mic and 3.50:1 two rows lower** — the same
  token, failing by different amounts, because on this screen the ground is
  `HeatField` and the ground is moving. No token choice fixes a variable that is
  underneath. On `colors.surface` the same line measures **7.18:1**.
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
- **`RIDIK_FREE_SIGNING=1` builds an iOS app a free Apple ID can sign**, for putting Ridik on
  a tester's phone for seven days without the $99 Developer Program. It works by *removing*,
  and everything it removes is something a store build needs — so it is off by default and
  `free-signing.test.ts` asserts the switch reads one named variable against an exact string
  rather than truthiness. A personal team cannot be granted a portal-provisioned capability,
  and Xcode fails to provision rather than warning, with a message about a missing profile
  that names no entitlement.
  Dropping `withRidikIosWidget` takes the App Group **and** the WidgetKit target together,
  which is right: a widget with no shared container is a blank tile, not a missing one. That
  is not sufficient on its own, because **`expo-notifications` writes `aps-environment`
  unconditionally** with no prop to stop it — so `plugins/withRidikFreeSigning.js` deletes the
  paid-only keys from the finished plist.
  **It is listed FIRST in the plugins array, and that is what makes it run LAST.** Expo's mods
  compose in reverse: the plugin registered last has its action executed first. Registered at
  the end, the stripper was handed an *empty* entitlements dict, deleted nothing, and left a
  plist that looked exactly as it had — nothing warns, and the only way to see it is to log
  the keys the mod receives. Do not tidy it back down the list.
  What the tester loses: home-screen widgets, and reminders breaking through a Focus. What
  they get back to you: `Export usage` on the Usage screen writes the local ledger to a file
  through the share sheet, which is what that layer was built for.
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
- **What to say is taught in the app, on the real screens — never as a panel.**
  It shipped as a fourth onboarding panel for a day: nine cards of quoted
  phrases, before the disclosure, on a screen where nothing is real. That is the
  wrong answer to the right problem. A voice app has no menu, so somebody *has*
  to be shown what it takes — but shown it in the app, over the real
  microphone, not read a page of quotations. `GuidedTour` does that, and it
  **walks**: fourteen steps that open the calendar, the lists, the money screen,
  habits, places, people, projects and focus in turn. That is not thoroughness
  for its own sake — somebody who has never seen the Money screen will never
  guess "spent fifteen forty on lunch" at a microphone, and a capability nobody
  can guess is one nobody has.
  Because it walks, **it lives in `app/_layout.tsx`, not on home.** It was
  mounted inside `app/index.tsx` while all four of its steps were there, and a
  provider inside home unmounts the moment the tour navigates off it, taking
  the step it was on with it. Home keeps the *targets*; it is the only screen
  with controls worth ringing.
  Six things it has to keep.
  **Every step shows something, and only what the sentence promised.** A step
  that lands on an empty Habits screen and says "this is where your habits go"
  has taught nothing — the reader sees a blank page and a caption. The second
  half of that rule cost a round of feedback: the focus step said "ask for a
  timer", the reader asked for twenty-five minutes, and the example answered
  with a five-minute break nobody had mentioned. That reads as the app doing
  something of its own accord, which is the worst impression a tour can leave
  when the whole product is asking to be trusted with a sentence. `sample` on the step is two or three faked lines of
  what that screen looks like once it has been used, drawn *in the card*,
  animated in at reading speed. It is written nowhere and read from nothing, so
  it cannot leak into real rows. It is dropped on a step whose target is a real
  control that already says the same thing — a ringed "Nothing left today" with
  a mocked "Dentist — in 2 hours" under it reads as two contradictory answers.
  **The copy is spoken, not specified.** Read it out loud before changing it.
  "Tap it and say what is happening" is a manual; "Just talk to it — say what's
  on your mind" is a person. Contractions are correct here.
  **It goes straight to each screen, and this was settled the hard way.**
  For a while every hop went through `/menu`: open the sheet, ring the row the
  step is heading for, press it, then the screen. The reasoning was sound — a
  voice app has no menu, so somebody shown nine screens learns nothing about
  reaching any of them — and it was still the wrong trade, twice rejected on a
  real phone. The menu is a *presented sheet*, so a hop became five moves and
  about three seconds to deliver one sentence about Habits, and nine of those is
  a tour nobody finishes. Step four rings the menu **button on home**, which is
  where a person actually looks for it, and the last step says what else is in
  there. Home is the hinge: pushed from home, replaced between screens,
  dismissed back to home at the end, so the stack is never deeper than two.

  **There is no close, on any step.** One was offered on the home steps and
  taken out: a corner × on the first screen of an app somebody has just
  installed is a thing to press to make the app start, and pressing it skipped
  the only explanation the product gets to give. The walk is fourteen taps and
  it ends by coming home. Stopping in the middle would have dropped somebody on
  the Places screen with no idea what it was anyway.
  **A screen step's title is the screen's name**, matching the menu row and the
  screen's own heading — the tour now shows all three within a second of each
  other, and any disagreement between them becomes the reader's problem. That
  is what settled Ledger/Money/"What you spend" into **Money** everywhere.
  **`done` is what closes it, not `tourSeen`.** The setting is a mutation: it
  writes SQLite and a query cache, and until one lands `seen.value` is still
  false. Ending on that alone left the card up for the length of a round trip —
  and since `finish` also reset the index, what the user saw after pressing Got
  it was the tour *restarting at step one*. The setting is persistence; local
  state is the dismissal. `tourSeen` is still read with the **same `isLoading`
  guard** `ConsentGate` needs, or the tour flashes over the first frame of every
  launch on an install that has already walked it.
  **The targets measure themselves** (`useTourTarget`, `measureInWindow`,
  deferred a frame because Android answers a same-pass measure with zeroes)
  rather than being a table of coordinates that goes stale the first time
  anything moves. And the spotlight is a *shape*, so the card is a live region
  on Android and announced on iOS.
  The dimming is **one view with an enormous border**: the hole is its content
  box, the scrim is its border, and RN follows CSS in rounding the *inner* edge
  at `borderRadius - borderWidth` — so a border of `B` and a radius of `r + B`
  cuts a hole with corners of exactly `r`. Three earlier versions look right in
  a still and are not. Four rectangles around the hole leave a **square**
  cut-out with a circular ring floating inside it. Adding four rounded corner
  pieces fixes the shape and leaves a hairline of undimmed screen at twelve,
  three, six and nine o'clock where they abut — antialiasing, not arithmetic, so
  rounding the coordinates does not help. And closing the hole by animating the
  frame to zero leaves `RING_PAD` on every side, so a 20pt disc of undimmed
  screen sits in the middle of every step that points at nothing, reading as
  dirt on the lens: **the padding is animated too**. A mask would work and needs
  SVG, whose mask support differs enough between the platforms that the hole
  comes out a different size on each.
  The scrim also **lightens to `SOFT_SCRIM` when there is nothing to ring**. A
  step whose whole point is "here is the Money screen" is asking the reader to
  look at the screen, and pressing it to spotlight depth hides the thing the
  sentence is pointing at. Two things that are *not* that, and both shipped as
  bugs because they looked like it. A step that **names** a control the screen
  is not currently showing — there is no receipt until something has been said —
  is still about that control, and softening there dimmed nothing anybody was
  meant to look at and left a card floating over a live, undimmed home screen.
  And the softening is keyed on **`arrived`**, not on the step: it starts the
  moment the index moves, which is before the next screen opens, so the scrim
  visibly lifted off home for the quarter second in between. A step's lighting
  belongs to the screen it is about, once that screen is there.

  **What the menu detour cost, kept because every one of them is a trap that
  outlived it.** None of these warn, and all of them were found on a device.

  - **A sheet needs something behind it.** Replacing the screen you are on with
    a presented one leaves nothing underneath a presentation that is transparent
    by construction: on Android the card floated over bare black for half a
    second between every pair of screens. That is what "it just flashes" was,
    and no amount of easing fixes it.
  - **A sheet-to-screen `replace` animates nothing**, whatever
    `animationTypeForReplace` says, because dismissing a presentation and
    pushing a screen are not one operation. Two moves are two animations.
    (`animationTypeForReplace: 'push'` is still set in the root layout, and is
    worth keeping on its own account: the default is `pop`, which drops the
    incoming screen in with no transition, and `replace` is how every
    destination in this app opens.)
  - **An overlay in the root layout cannot draw over a presented screen.** On
    iOS a `presentation: 'modal'` screen is its own view controller over the
    root view, so a sibling of `<Stack>` is *underneath* it. The ring was drawn
    perfectly, behind the menu, with nothing to warn you.
  - **A position measured against a moving layout is not a position.** Three
    failures, all the same mistake: measured while the sheet was still
    presenting it landed two rows out on a phone; measured before the list
    scrolled it ringed whatever slid underneath; re-measured to fix that, it
    handed a 420ms ease a new target every 90ms and never arrived at all. If a
    highlight can be a *style on the thing* rather than a rectangle over the
    screen, make it one. And **`measureInWindow` returns floats**, so anything
    comparing two samples for equality must round first.
  - **`useTourTarget` must not key an effect on the context.** Its value is a
    new object on every reported frame, and that effect's teardown cancels the
    pending `measureInWindow`. On home nothing else moves while the frames
    settle, so it never showed. The context lives in a ref, written from an
    effect.
  - **Frame reports are batched** into one animation frame. Thirteen targets
    measuring themselves was thirteen context values and thirteen renders of
    everything under the provider.
  - **Screenshots do not find any of this.** `xcrun simctl io booted
    recordVideo` and `adb shell screenrecord`, then `ffmpeg` to frames, do.

  The restart lives on `/examples`, not Settings — both answer "how does this
  work?", and somebody asking it is already there. And the **briefing waits for
  the tour**: it is a modal route, so it is presented above the tour the same
  way it used to be presented above `ConsentGate`, and on a clean install a day
  summary slid up over the thing that was about to explain the microphone
  underneath it.

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
- **The best upgrade engine sends nothing anywhere, and that is not a
  consolation prize.** `whisper-local` is whisper.cpp through `whisper.rn`
  (`src/voice/whisperLocal.ts`), reading the *same WAV* the recogniser kept —
  the format is already 16 kHz mono PCM, because that is what the recognition
  service is fed, and it is exactly what whisper.cpp wants. No conversion, no
  second recording. Measured on a device: **1.84s for a 4-second utterance,
  transcribed correctly with punctuation, with the network off.**
  It is the only upgrade engine with **no recipient**: nothing is uploaded, so
  it adds no sentence to `ConsentScreen`, needs no key, costs nothing per
  utterance, and is the one that still works with the assistant declined or on
  a plane. The model download is a *model coming down, not a recording going
  up*, so it sits under the same documented exception `modules/ridik-speech`
  already relies on.
  What it costs is a ~57MB model and seconds of CPU, which is why it is behind
  the caption rather than in front of it, and why `ensureModel()` is **fired and
  never awaited** — the same shape `./apple` uses for `SpeechAnalyzer`'s
  assets. A phone without the model yet keeps the recogniser's transcript for
  *that* turn; the turn after it lands is the better one and nobody watched a
  progress bar. `status()` is uncached for the same reason it is there: a
  remembered "absent" would need the app restarted before it could use a model
  it had just finished fetching.
  **`confidence` is `null` and must stay null.** whisper.cpp reports none, and
  synthesising one from segment timings would hand `wasPoorlyHeard` a number
  that looks measured and is not — strictly worse than the honest absence it
  already knows how to read.
  **On an iPhone it rescues exactly the phones that need it, and does nothing
  on the rest.** iOS has two recognisers behind one door: `SpeechAnalyzer` runs
  through `./apple`, keeps no audio, and measures 2.12% WER — *better than this
  model*, so there is correctly nothing to upgrade there. Every other iPhone
  falls back to `SFSpeechRecognizer` at 9.02%, and those are the ones this
  fixes. The setting means the same thing on both platforms; it simply has
  nothing to correct when the recogniser was already the good one.
  **The format is the iOS-specific part**, and `keptAudioOptions()` in
  `./capability` is the only thing that decides it. Android already writes
  16 kHz mono 16-bit PCM — it is what it feeds the recognition service — and
  ignores the fields. iOS records at the input node's own 44.1/48 kHz *float*
  unless told, which whisper.cpp cannot read. So `captureAudio` carries a
  format rather than a boolean, and `./stt` forwards it without knowing the
  platform, which it could not read anyway.
  **And the two platforms do not name the files the same way**: Android writes
  `recording_<epoch ms>.wav`, iOS `recording_<UUID>.wav`. A sweep pattern
  matching only digits is right on one and matches *nothing* on the other,
  which is a silent leak — a sweep that finds no files looks exactly like a
  sweep with nothing to do. `kept-recording-names.test.ts` holds both, and
  holds the negative half too: this runs over the whole cache directory.
  **A cold context costs 14.3 seconds and a warm one 1.6**, measured. Opening
  one reads a 59MB file for the first time and initialises the runtime, so
  leaving it lazy would park the first sentence somebody speaks in `sending`
  for a quarter of a minute — the exact impression of a broken microphone the
  "recogniser answers first" design exists to avoid. `prepare()` fetches the
  model *and* opens the context, fired and never awaited, the moment the engine
  is chosen. **The simulator is CPU-only** and says so: `reasonNoGPU` reads
  "Metal is not supported in simulator", so every number above is a floor and a
  real iPhone has Metal.
  Three things that cost a device probe to learn, none of which fail loudly:
  **`whisper.rn` depends on `safe-buffer`, which needs Node's `buffer`**, absent
  in React Native — so the *import* fails and the engine reports itself
  unavailable. That is the correct degradation and completely silent; the fix is
  one scoped entry in `metro.config.js`'s `extraNodeModules`, and the symptom
  ("Offline transcription is not available") points nowhere near it.
  **The bare specifier does not resolve**: the package's `exports` map has a
  `./*` pattern and no `.` entry, so it is `whisper.rn/index` under both
  `moduleResolution: bundler` and Metro's package exports.
  And **the native module is imported lazily, never at module scope**, because
  a build that has not been prebuilt since it was added must still load this
  file — import failure is a normal answer here.
- **The recogniser and a better engine can both have the same utterance, and on
  Android that costs nothing.** The trap every rung below is stuck in: a rescue
  fires when the recogniser *failed*, and the failure that hurts is a
  recogniser that succeeds and is wrong. `primary` escapes it by replacing the
  recogniser outright — and pays with the live caption, which is the one thing
  making send-on-release safe. `upgrade` (`CaptureOptions.assemblyai.upgrade`)
  pays nothing: the recogniser runs normally and draws the caption, and the
  audio it *already heard* goes to AssemblyAI for the transcript that commits.
  **It is not two microphones, and that is the whole discovery.** On Android 13+
  the recognition library owns one `AudioRecord`, writes the PCM to a file and
  hands that same stream to the recognition service as
  `RecognizerIntent.EXTRA_AUDIO_SOURCE` (`ExpoSpeechService.kt`, guarded on
  `TIRAMISU`). There is no contention to lose, because there is only one
  capture. Measured on a device before any of this was written: a 16 kHz mono
  16-bit WAV in the app's cache, partials still arriving word by word.
  `canCaptureAudio()` is the floor and it is hard — below API 33 the library
  accepts `recordingOptions` and *silently ignores it*, so a caller that asked
  anyway would wait for a file that is never written. `minSdk` is 26.
  **Stopping is safe; aborting is not.** The library's `stop()` calls only
  `speech.stopListening()` and leaves the recorder running until `onResults`;
  `abort()` tears both down at once. That matters because a stream ending the
  instant speech does loses the last word — measured: the same probe returned
  "…on Tuesday at" with no trailing silence and "…on Tuesday at 3" with two
  seconds of it, **both at 0.952 confidence**. A truncated transcript that
  reports high confidence is the confident-wrong failure in miniature, and the
  reason not to invent a tail-trimming optimisation here later.
  Three rules on the upgrade itself, and the second is the one that matters:
  the better transcript wins; **a failed upload is never the reason a turn
  fails** (the recogniser's own words stand, including when the upload throws —
  `captureUtterance` promises not to throw and this rung is inside that
  promise); and an *empty* upgrade is a failure rather than an answer, because
  taking it would turn a good turn into "I didn't catch that".
- **A recording is somebody's voice, and only one ending hands it to anybody.**
  `onFinal` carries the `audioUri` out and the caller deletes it. Every other
  ending — an error, a cancel, and above all the silent retry over the network
  — had nowhere to put it, so `onDiscardAudio` exists and `finish()` is the
  funnel. It is a *callback* rather than a delete because `stt.ts` has to stay
  loadable under plain Node for the `logic` project; one `react-native` import
  at the top of that file takes three suites down with a parse error that names
  none of this, which is also why `canCaptureAudio` lives in `./index`.
  **That still leaks, and `sweepKeptRecordings` is why.** The uri reaches JS on
  `audiostart`, and a session that dies *before* that has already had its file
  written natively and can never name it. The common early death is not
  hypothetical — an on-device engine reporting `language-not-supported` for the
  locale, retried over the network, which on such a phone is **every single
  utterance**. Measured: one turn, two orphaned WAVs. So the ladder sweeps the
  cache for the library's own `recording_<ms>.wav` naming, on both sides of a
  turn — and **only the sweep on the way *in* is a guarantee**. By then nothing
  of ours is listening, so everything matching is finished with, whatever left
  it. The sweep on the way *out* is opportunistic, and saying so cost two runs
  to establish: `captureUtterance` resolves when the *transcript* arrives,
  which is before the recognition library has run its own native teardown, so a
  file still being closed is not in the listing yet. Measured — of the two
  recordings a retried turn produces, the out sweep took the first and could
  not see the second, 367ms younger. It is kept because one of two beats none.
  **Do not try to close that race with a delay**: the teardown is native and
  asynchronous, a timeout long enough on this emulator is a guess everywhere
  else, and the way-in sweep already covers what it would buy. The bound that
  actually holds is *at most one turn's recordings, and only until the next
  time anybody speaks*. `./record`'s own recordings are `.m4a` under a name
  `expo-audio` chooses, so a Whisper upload in flight is outside the pattern.
- **There are four transcription engines now, and only one of them is a rescue.**
  `whisper.ts` was reached *only when the platform recogniser failed*, which
  covers a dead session and a missing locale model and does nothing at all for
  the failure this app was actually reported for: a recogniser that returns a
  confident transcript with half the words missing. A confident wrong answer
  never fails, so it never reaches a fallback. So `assemblyai.ts` is wired as an
  **engine** — `sttEngine: 'device' | 'assemblyai'`, and `primary` in
  `CaptureOptions` is what makes it run *instead of* the recogniser rather than
  after it.
  Two conditions, deliberately separate: the **key** makes the rung possible,
  the **setting** makes it primary. An engine that uploads audio must never
  become active because a credential arrived — only because somebody chose it
  on a screen that says what the trade is. With a key and the setting untouched
  it is a better rescue than Whisper and nothing more, so the Settings row is
  hidden until a key exists (a choice between one option and one that cannot
  run is an advertisement, not a choice).
  **What it costs is the live caption**, and that is a hard constraint rather
  than a decision: `expo-audio`'s recorder writes a file and has no PCM
  callback, and AssemblyAI's realtime API wants a socket fed raw frames. Getting
  partials out of an upload engine needs a native audio module — the same shape
  of gap as Live Activities. `record.ts` exists because the fiddly half of this
  is not the recording, it is taking the audio session and giving it back and
  deleting the file whether the upload succeeded or threw; a second copy of that
  is a second place for a file holding somebody's voice to survive a failure.
  **And the best English option is free and local, and it is wired now.**
  See the entry below. See also `notes/STT-OPTIONS.md`.
- **On an iPhone, "the phone's recogniser" means `SpeechAnalyzer`, and there is
  no setting for it.**
  `modules/ridik-speech` is the native module and `src/voice/apple.ts` drives
  it. Apple's `SpeechAnalyzer` (iOS 26) measures **2.12% word error rate on
  clean speech against `SFSpeechRecognizer`'s 9.02%, and 4.56% against 16.25%
  on hard audio** — four times fewer wrong words, on the same audio, from a
  framework this app was not using.
  **It is not a choice, and that is the whole design.** Every other engine here
  is a trade. This one is better on every axis at once: fewer errors, *more*
  private (the platform recogniser streams to Apple's servers whenever the
  phone has no offline model; this never leaves the phone), free per utterance,
  and it keeps the live caption the upload engines cannot produce at all. There
  is no answer to "would you like four times more wrong words", so `./stt` picks
  it silently, no row was added anywhere, and `captureUtterance` and the
  pipeline above it are untouched. `source: 'apple'` on the result is the only
  way to tell which engine answered — and the pipeline logs it, because with
  four rungs and a silent fallback the next person asking "is it still
  mishearing me?" cannot answer without knowing which one produced the sentence.
  **The notes were wrong about the cost, and the SDK is where that was
  settled.** This file and `notes/STT-OPTIONS.md` both recorded that
  `SpeechAnalyzer` has no custom vocabulary and that adopting it would lose
  `dictionary.ts` — "the only fix for the one error the rest of the pipeline
  cannot recover from". It does have one: `AnalysisContext.contextualStrings`
  is a `[ContextualStringsTag: [String]]` and `.general` is the tag for exactly
  this. The bias list is handed over unchanged, and the one stated reason not to
  do this never existed. Read the `.swiftinterface` in the SDK
  (`Speech.framework/Modules/Speech.swiftmodule/*.swiftinterface`) rather than
  trusting a summary of an API — it is the authority, it is on this machine, and
  it is how `.transcriptionConfidence` was found too.
  **It brings the first real confidence reading this app has ever had on Apple's
  side.** `wasPoorlyHeard` in `src/llm/confirm.ts` has been working from `null`
  on iOS since it was written, because `SFSpeechRecognizer` mostly declines to
  say. `SpeechConfidence.mean` is the **mean over the runs weighted by text
  length**, deliberately *not* `./stt`'s minimum: a segment there is a clause,
  a run here can be one word, and the worst word in a sentence reported as the
  sentence's confidence rejects almost everything against a 0.7 threshold —
  a working recogniser made to look broken.
  **The model is a download, so readiness is checked and never waited for.**
  A phone that does not have it yet uses the old recogniser for *that*
  utterance and fetches the model in the background; the turn after it lands is
  the better one and nobody waited. Only `installed` listens. The two
  non-terminal statuses are deliberately **not cached** — a remembered "not
  yet" would need the app restarted before it could use a model it had just
  fetched — while `unsupported` and `installed` are, because they do not change.
  The download sends nothing of the user's, so it adds no recipient to the
  consent screen and is allowed on the `onDeviceOnly` path. That is the point of
  it: before this, a declined-consent iPhone with no dictation model got
  `NO_OFFLINE_VOICE_MESSAGE` and no way forward, and now it can fetch the thing
  that makes the promise keepable.
  **`minSpeechMs` is 0 here and `DEFAULT_MIN_SPEECH_MS` in `./stt`, and that is
  the one place the two endpointers are configured apart.** That floor is a
  *duration* of speech and `./stt` can measure one — `speechstart` and
  `speechend` bracket the real thing. `SpeechAnalyzer` reports no speech
  boundaries at all, so the only timestamps available are the moments results
  arrived, and for a short utterance that is a single instant spanning 0ms.
  Keeping the floor meant "yes", "done" and "log it" could never satisfy it and
  nothing but the sixty-second hard cap would end them: a one-word command with
  the microphone held open for a minute. Nothing is lost, because the floor was
  a proxy for "was that speech?" and this engine only ever notes speech when
  *recognised words changed* — and whether the words amount to anything is
  `evaluateTranscript`'s job either way.
  Two more things that will bite. **Only a changed result counts as speech**, or
  a volatile result re-reported during silence holds the microphone open for
  ever. And **a start failure is returned, never announced**: `./stt` falls back
  to the platform recogniser on that path, and an `onError` would resolve
  `listenOnce`'s promise before it could.
- **`SpeechAnalyzer` does not exist in the iOS simulator, so the bench runs on
  the host.** `SpeechTranscriber.isAvailable` is **false** there and
  `supportedLocales` is **empty** — no on-device models ship with a simulator,
  so the analyzer path cannot be exercised on one at all and the app correctly
  falls back to `SFSpeechRecognizer`. That is worth knowing before an hour goes
  into wondering why the good engine never engages on a simulator.
  `notes/speechlab` is the way round it, and it is the same trick
  `notes/tilelab` plays on the widget faces: these are plain frameworks, and
  `SpeechAnalyzer` reads an **audio file**, so it compiles as an ordinary
  executable and runs against real models — `--host` on this Mac (macOS 26 has
  the same framework and real models), `--sim` inside the simulator to show
  that it is absent. `say` speaks the sentence, so a whole rung is measured with
  nobody talking to a phone. It links the shipped `SpeechConfidence.swift`
  rather than a copy, which is why that file is separate from the session and
  free of `AVFAudio` — `AVAudioSession` does not exist on macOS and would make
  the session file uncompilable there.
  What it proved: 13 volatile results for one sentence (so the live caption is
  real), `.transcriptionConfidence` populating at 0.887, the asset install
  moving `supported` to `installed`, and — the one that would have been a bug —
  that **a volatile result covers only the un-finalised tail**, so
  `finalized + volatile` accumulates correctly instead of repeating the prefix.
  **What no simulator and no bench can verify is the live microphone path** —
  `AVAudioEngine` tap, `AVAudioConverter`, `AnalyzerInput`. That needs an
  iPhone on iOS 26.
- **A recipient added is a sentence added, and the test enforces it.**
  `STT_PROVIDER` is `'AssemblyAI'`. Adding the constant turned
  `consent-screen.test.tsx` red until both the screen *and* that test's own
  hand-written list named it — which is exactly what that pair is for, and the
  first time it has fired for a recipient it did not already know about.
- **The first run asks three questions, and the bar for a fourth is high.**
  `PreferenceStep` sits between the permission asks and the disclosure — after
  permissions because until the microphone is granted there is no app to have
  preferences about, and before the disclosure because the disclosure has to be
  the last thing read before anything can be sent. A page of switches after it
  would put three more decisions between reading the promise and living under
  it.
  The test for being on that screen is not "is this personal" — it is **can the
  default be wrong for somebody in a way they will not find out about**.
  Speaking replies is off for the life of the app; the confirmation gate had no
  UI at all; and the clock reads a device signal Android does not carry. Colour
  fails that test and stays on Settings. It writes as you tap, with no Save:
  there is nothing to lose by leaving early, and a form that must be submitted
  turns a preference into a commitment.
  **Anything onboarding asks, Settings has to be able to change.** "Speak
  replies" came back from `/developer` for exactly that reason — the reasoning
  that sent it there was sound only while nothing ever raised the subject. The
  `ttsRate` slider stays behind the gate, which keeps the original point: the
  knob that can make speech unlistenable is still a developer's, and only the
  yes/no a stranger can answer is on Settings.
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
- **Every write has an opposite, and the two are one spoken word apart.** For a
  long time half of them did not: a list could gain an item and never lose one,
  a task could be completed but not rescheduled or deleted, and a mis-heard
  amount was permanent once the receipt scrolled away. That is not a missing
  feature, it is the one thing a voice-first app cannot leave out — the whole
  premise is that you do not have to look, and a user who cannot correct by
  voice has to. `checklist_remove`, `checklist_delete`, `task_update`,
  `task_delete` and `ledger_delete` close it.
  What they introduce is worse than what they fixed if it is left unstated.
  **Ticking an item off is not taking it off, and completing a task is not
  deleting it** — one of each pair claims the thing *happened* (a completed task
  feeds the day's counts and unlocks what waited on it; a ticked item stays on
  the list and un-ticks with one tap) and the other says it never will. They
  sound identical out loud. RULES 6 in `prompt.ts` is the model's half, the
  `note` on those groups in `phrases.ts` is the user's, and the receipt's
  sentence is what tells you which one happened — "Took the coffee off the
  shopping list", never "Done".
  Every one of the destructive five asks a second time with the *resolved row*
  in the question, not the words: the review gate showed "the coffee", and what
  gets deleted is a row it scored. `checklist_delete` puts the count in the
  question for the same reason — "delete the shopping list" is an entirely
  reasonable sentence right up to the moment it had eleven things on it.
  Two knock-ons worth knowing. `MAX_NARROWED_TOOLS` moved 12 → 15: three domains
  own a "that one is done now" tool, so "mark the frame as printed" takes tasks,
  checklists and projects, which was 13 tools once each of those gained its own
  opposite — one over the old ceiling, so the whole utterance silently fell back
  to the full surface. A cap tuned to one contract size stops narrowing the
  moment the contract grows. And `prompt-cache.test.ts` now scales its ceiling
  by `TOOL_NAMES.length` rather than carrying a flat number: the 7,240-token
  measurement is a real reading from a live call on a 28-tool contract, and a
  measurement edited to make a test pass is not one any more.

- **One question per thing worth asking, and three ways that was broken.**
  All three were found by a user in one sitting, and none of them is a bug in a
  single function — each is two correct mechanisms meeting.
  **A yes to the model's own question already reviewed the actions.** RULE 4
  requires the model to propose the concrete thing ("Book it Thursday at
  16:00?"), and a `clarify` has nothing parked to replay — so a yes went back to
  the model, came back with actions, and met the review gate asking the same
  thing in the same words. `runTurn` now passes `reviewed: true` for a turn that
  is a yes to a model question, and `reviewed` only: the handlers' checks still
  run, because a clash is a fact the proposal could not have contained.
  **Never ask about a row that is not there.** The gate is deliberately upstream
  of every handler, so "tick off the matches" asked, took a yes, and *then* said
  there are no matches. `provablyMissing()` is a cheap read in front of the
  gate — deliberately not a general resolve, which would put a query on the
  front of the fast path and duplicate ten handlers' matching rules. It answers
  only when it can prove absence.
  **And `confirmMode` had no UI at all.** It shipped with the executor, with a
  documented default and no row on any screen, so a user who found the questions
  too frequent had no way to say so. It is on Settings now — the app works at
  every value, and only the middle one is a judgement call.
- **A confirmation card is laid out, not printed.** `previewSentence` flattens
  the preview for *speech*, and the card was rendering that sentence: "Add to
  calendar — Title: Gym, Starts: Tue 10 Mar, 15:00?", one run-on line of labels
  and colons. `ActionPreview.lines` is `{label?, value}` pairs now and survives
  to the screen, so the kind of change is a heading and every value has a line.
  The kind matters most and was buried at the head of a sentence nobody reads to
  the end: "Add to calendar" over "Add a task" is two entirely different rows.
- **Moving is not adding, and a relative move needs a field of its own.**
  `calendar_update.start` is an absolute wall clock, so "move the physio fifteen
  minutes later" could only be answered by *knowing* the current start — which
  the model knows only for the events the context window carried. Asked about
  anything else it invented a time or filed a `calendar_add`, and what the user
  got was a brand new event fifteen minutes from *now*, beside the one that
  never moved. `shift_minutes` (signed) is resolved in the executor against the
  row, so the arithmetic happens where the true value lives; `task_update` takes
  one too, and refuses in words on a task with no deadline rather than inventing
  one. The contract rejects `start` and `shift_minutes` together.
- **Speech sets the rare field; the sheet holds what a hand reaches for.**
  `TaskDetailSheet` had Priority, Estimate, Project and Notes as four more
  sections of chips and a text box, in front of a list whose two useful actions
  are "done" and "when". They are gone — the *fields* are not, and every one is
  still settable by voice, which is the split this app runs on. What is left is
  the title, complete, the deadline the whole screen buckets by, prerequisites
  and delete. The argument for adding a control back is that somebody reached
  for one and found nothing, never that the column exists in the table.
- **A blocked task leaves Active, so something has to say where it went.**
  "I can't solder the board until the bearings arrive" files a dependency and
  the soldering task vanishes from the list the user was looking at — correctly,
  and with a "· 1 blocked" in the subtitle as its only trace. The receipt now
  routes to `/tasks?view=blocked` rather than `/tasks`, which opened the one
  screen the task is not on, and the tab carries its own count. The honest
  question this came back as was "where should I see that?".
- **An answer is not a receipt.** `LastAction` drew every `ok` item the same
  way, so "what does my day look like" arrived as a two-line clamp with the word
  **Done.** in front of it. A receipt reports a change: short, wants a tick,
  wants an Undo. An answer is the thing that was asked for — no tick to earn,
  nothing to take back, and as long as the day is. `isWrite` already draws that
  line for the confirmation gate, so it is the same list rather than a second
  one that can drift.
- **A first habit log says it is the first.** `logHabit` creates on demand,
  which is right — "log stretching" must not fail because nobody declared
  stretching first — but "Logged Stretching." was the same sentence whether it
  added a day to a habit kept for a month or invented a fourth from a mis-heard
  word. `HabitLogResult.created` says which, because the second case is exactly
  where the numbers on the Habits screen visibly do nothing: one day out of the
  elapsed window, every other ring untouched, and somebody watching for a
  percentage to move concludes the log was lost.
- **The menu pushes, so Back lands on the menu.** It replaced, on the reasoning
  that "the menu is a junction, not a step" — reasonable, and wrong about what
  somebody is doing when they open a list of nine screens. They are looking, and
  going home after each one means reopening the menu to see the next. Two deep,
  never more: the entries are all leaves.
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
  a longer sentence scrolls, with its top line sliced by the scroll edge.
  **There was a fade over that edge and it had to go**, for the one reason its own
  docblock ruled out: it was six 3pt bands of `colors.bg`, argued as "the ground, not
  black" — and on *this* screen the ground is not `colors.bg`, it is `HeatField`. The
  caption sits directly over the ember core, so the softening rendered as an opaque
  brown-black strip across the brightest part of the hero, at the exact moment the user
  was talking to it. Any opaque colour is wrong over an animated gradient; the only
  correct version is a mask, and SVG masks come out a different size on each platform.
  A sliced top line is much the cheaper defect.
  **And the caption has one typographic treatment, not two.** The transcript was set in
  `caption` while the resting label was an `eyebrow`, so the slot changed typeface, size
  and weight the instant you started speaking — the calmest moment in the app was the one
  where the type jumped. Both are `eyebrow` now. What survives of the old argument is that
  the *words are not upper-cased*: a fixed label can shout, somebody's own dictated
  sentence may not. The Android `letterSpacing` objection does not apply here, because this
  line already carries the documented remedy — an explicit width, centred with `textAlign`.
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
- **Two temperatures, and that is the whole semantic palette.** It was five hues
  — a green, a yellow, a red, a blue and the ember — and the arithmetic is what
  condemned them: they measured 8°, 34°, 150° and 193°, so `danger` landed **5°
  from `accent`** and `warning` read as a dirty orange. Meaning cannot live in
  hue when the hues are that close, and nobody should have to learn a
  five-colour legend to use an organiser. What is left is **warm** (live, yours,
  now, going out, needs you — the ember) and **cool** (settled, kept, done,
  coming in — metal that has cooled). `success` and `info` are the same slate,
  because a finished task and a rest interval are both "nothing to do";
  `warning` *is* the accent, told apart from a plain accent chip by its word.
  Severity is carried by **weight, not by hue**: a tint with coloured text is
  worth noticing, a solid fill with ground-coloured ink needs acting on.
  Which direction that weight goes is **not the same in the two schemes**, and
  pretending it was is what made the dark palette mesh. Light has room below the
  ember, so `danger` is the burnt end — darker, deeper, redder. Dark has none: a
  colour readable on `surface` bottoms out at L\* 62.6 and the accent is already
  67.9, so every "deeper" red down there is one nobody can read. Weight in a
  dark room is emitted light, so danger climbs to a pale ash-rose instead.
- **A tinted chip is read against its own tint, and nothing was measuring that.**
  Every muted token is paint over a card, and the ground a label actually has is
  the composite — so a colour too light to read is *doubly* too light there. Two
  ember accents and two tag tints shipped between 2.45:1 and 4.39:1 on plates of
  themselves with every contrast rule in `palette.test.ts` green, because all of
  them were checking a ground the chip is never drawn on. There is a rule for it
  now, in both files, and `accent` is a field on `EmberOption` rather than the
  ramp's `hot` because the two jobs came apart the moment it was applied: a heat
  cell wants the emitting colour, an ink wants the readable one.
- **A colour is either a channel or it is noise.** The tag ramp used to be
  hashed from a word and applied to everything — spending categories, note tags,
  project kinds, habit chips, Activity rows. It looked like meaning and was not
  (nothing about "School" is gold), and with five tints and a hash, two items on
  one screen regularly came out identical anyway. It survives in the one use
  colour is actually for: **many peers on one screen, each needing to be told
  from the next at a glance, with no other mark doing the job** — a timetable
  grid, a month of event dots, a column of avatars. Everywhere else the word is
  the identity, and `Chip` with no `color` is quiet until it is the one that is
  selected, which is the only question a row of chips has to answer.
  Two corollaries that were both shipped bugs. **Completion recedes** — a logged
  habit drawn as a solid pale fill was the brightest thing on the Today screen,
  spent on the one item asking nothing of anybody, so `Chip` takes `fill="soft"`
  for a state it is *reporting* and keeps `solid` for a choice that is *on*. And
  **an empty checkbox is not a state worth a colour**: every open task drew its
  box in the accent, which put six identical ember squares down a list where the
  priority bar two lines away is careful to colour only the one row that changes
  what you do next.
- **Nothing is neutral grey.** Every "black" is a warm brown, every "white" is
  linen. A true grey next to this palette reads as a bug.
- **A class component cannot call `useTheme()`, and reaching for `makeTheme()`
  instead splits the scheme in two.** `ErrorBoundary` painted its own background
  from a hard-coded `makeTheme('dark')` — it has no hooks — while every `Txt`
  inside it read `useTheme()`, which is the *provider's* scheme. On a light
  phone that is dark ink on a near-black panel: an error screen nobody can read,
  which is the one screen that has to be, across all 41 places the boundary is
  mounted. The fixed scheme was never needed — `ThemeProvider` is an ancestor of
  every boundary, so the fallback is a **function component** now and reads the
  same theme as everything else. Same mistake one layer down in its own
  stylesheet: a literal `rgba(255,255,255,0.04)` wash, invisible on linen.
  If a class needs the palette, render a child that can ask for it.
- **The clock has two formats, and a column that renders one has to be sized
  for the other.** `HH:mm` was hard-coded at every render edge, so an American
  install read `21:00` on a phone whose own status bar said 9:41 PM — and the
  *widgets* had been right the whole time (`DateFormat.is24HourFormat`, and the
  `ridik_rows_ampm` layout variant that exists for precisely this), so a tile
  and the app that published it disagreed about the same event. `formatTime`
  and `formatDateTime` read one piece of module state in `src/core/time.ts`,
  beside the zone and for the same reason: a setting read at every render but
  applied only at bootstrap changes nothing until the process is killed, so
  `useSettings.ts` applies both on the write and invalidates `qk.all`, because
  a clock reading is cached inside every day query.
  Three values, not a boolean. `auto` reads the device and is a good default
  and a bad promise — `Intl` resolves from the *locale*, which on iOS does
  carry the 24-Hour Time switch and on Android does not, `Locale.getDefault()`
  knowing nothing about that system toggle. That gap is the whole argument for
  `12h` and `24h` being sayable on Settings rather than inferred. And `auto` is
  resolved **once, when it is applied**, never per call: resolving it per call
  would make every rendered time depend on ambient locale, which under Node is
  the suite's own — the same untestability `now()` exists to prevent.
  **The widths are the part that bites.** `21:00` is 45.0pt of `mono` (Martian
  Mono at 13, monospaced, so this is arithmetic) and `12:00 AM` is 72.0. The
  gutters were 46 and the briefing lead 52, and what a `Text` with room for one
  line and content for two does is **wrap**, not truncate — so a 12-hour
  install rendered "3:00" over "PM" down the whole Today agenda. Tracking is
  −0.2, which would take it to 70.4, and Android does not count `letterSpacing`
  when it measures, so 72 is the number. `clockColumnWidth()` owns it and the
  three columns take it. The first attempt used 64, measured in **Bricolage**
  by mistake: it typechecked, the suite was green, and it wrapped on the first
  device it was put on. Measure in the face the text is actually set in.
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

**A surface with nothing in it does not paint itself, and the surface is what
enforces that.** `Card` draws its own ground, border, 16pt radius and
`spacing.md` of padding on four sides, so a card whose children all resolved to
nothing is not a shorter card — it is 24pt of bordered, rounded void sitting in
a list where the reader is looking for a row. That is what was photographed on
the Habits screen, and it is a whole defect class rather than one bug: about
thirty-five `<Card>`s in this app hold a single `{rows.map(…)}` or
`{cond ? … : null}` and depend on the *caller* having guarded the empty case.
Most do — the sweep found four unguarded shapes and every one of them turned out
to be unreachable by construction — but nothing makes the ones that do not
visible. It typechecks, it renders, and a test with fixture data never reaches
the state where every branch is false at once.

So `Card` and `Section` count their children and return `null` rather than
thirty-five call sites each remembering. `Children.toArray` is what makes that
work: it flattens the array a `.map` produces and drops `null`, `undefined` and
booleans, so an empty list and a ternary that fell through both arrive as
nothing at all. The guard sits **below** both hooks, for the reason in
*Environment gotchas*. `Section` goes with it because a heading is a label for
what is under it — `right` is always a modifier of the children (a count, a
"latest 6 of 40"), so a section that draws TRANSACTIONS over a gap is the same
defect one level out. The rule is "no children", not "no ink": a `<View>` used
as a spacer is a child the caller meant, and second-guessing that would be a
different bug. `empty-surfaces.test.tsx` holds all of it.

The one place this changed a test is worth reading, because the test was
encoding the defect. `tracking-screens.test.tsx` asserted the ledger drew
**"latest 0 of 2"** — a window readout over an empty Transactions section, from
a fixture whose summary query reported two transactions while `listRecent`
returned none. No database can produce that pair. A window is only worth
reporting when something is in it.

**A preview that hides a note shorter than itself is a directory, not a list.**
`NoteRow` drew a flat `PREVIEW_BULLETS = 2`, and that constant was smaller than
almost everything this app writes: Door Codes is three lines and showed two,
Line Practice is one sentence and showed one elided line, a Daily Log entry the
same. Every one of them had to be *opened* to read something that would have
fitted on the screen it was already on — and "+1 more" is the worst of it, a
whole line spent saying there is one line you are not being shown.
`src/features/notes/preview.ts` budgets **lines, not bullets**: a note that fits
is shown whole, and "+N more" appears only when something is genuinely held
back. `PREVIEW_CHARS_PER_LINE` is measured rather than guessed —
`notes/measure.py fits` puts a 92-character sentence at 579.5pt in the shipped
face at `caption`'s 13pt, against a 370pt row, so 58 characters. It has to be an
estimate: React Native measures text natively and asynchronously, and a preview
that waited for a real measurement would reflow the list under the reader's
thumb. `MAX_LINES_PER_BULLET` bounds the error in the direction that matters, so
one pasted paragraph cannot eat the budget and hide the four bullets under it.

**`\u2611` is an emoji, and `\u2610` is not.** A completed bullet drew the ballot
box with a check in *emoji* presentation on iOS: a rounded grey box with a white
tick, a different size and shape from the empty boxes above it so the column
went ragged, in a true neutral grey — the one colour this palette says reads as
a bug — and ignoring the row's tone, which made the ticked item the brightest
thing in the row. That is **completion recedes** broken by a character: the one
bullet asking nothing of anybody was the one that shouted. A variation selector
would be the narrow fix and is not portable; `Ionicons` nests inside a `Text`
run and wraps with it, which is how the rest of the app draws a checkbox and
means the marker is themed, sized and toned like everything round it.

**A `Chip` is a control, so a row of notes should not wear one each.** Every note
carried its tag as a chip that did nothing when tapped, directly under a
`TagStrip` made of real ones — and with a filter on, every visible row repeated
the tag the reader had just chosen. As plain `micro` text beside the timestamp it
costs 15pt instead of 24 and stops competing with the filter it duplicates.

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
- **An ancestor that claims the responder on touch-start silences every
  ScrollView beneath it.** `ConsentGate` has to stop a finger reaching the app
  underneath — a View with no responder lets touches fall through to the
  microphone — and the obvious place for that claim was the overlay's own
  wrapper. It is the one place it cannot go. A ScrollView deliberately does
  **not** claim on start (a tap on a button inside it would never land); it
  takes over on the first *move*, and an ancestor that is already the responder
  never hands it back. So the examples step could not be scrolled at all: two
  of nine cards, no error, no warning, and the whole suite green, because a
  renderer with no viewport has nothing to overflow. The claim is now a
  full-bleed `View` rendered *behind* `WelcomeFlow` — same guard, no longer
  between the ScrollView and the finger.
  Two more things came out of the same afternoon and both still apply, because
  the permission step is three rows and a heading and a small phone in a large
  font is where that stops fitting. `justifyContent: 'center'` with
  `flexGrow: 1` is right for a panel of three lines and wrong for anything
  taller than the screen; and a ScrollView in a column needs `flex: 1` of its
  own or it is measured at its content height and has nothing to scroll. All
  three had to be true at once, which is why only a device settles it. (The
  examples step that found this is gone — it is the guided tour now — but the
  lid is above every step, so the rule outlived the screen that broke it.)

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
- **`Sending \`onAnimatedValueUpdate\` with no listeners registered.` is a
  teardown race two libraries deep, and it is in `logbox.ts`.** A yellow toast,
  several at once, at the moment `boot` resolves and a batch of screens mounts.
  `react-native-screens` gives **every** native-stack screen an
  `onTransitionProgress` prop built with `Animated.event(…, { useNativeDriver:
  true })` — unconditionally, with no prop to turn it off — and
  `onHeaderHeightChange` the same way. React Native's own
  `createAnimatedPropsHook` attaches a **no-op JS listener** to each of those
  values so the Fiber and Shadow trees stay in sync, and on unmount removes it
  synchronously — dropping the emitter's count to zero while
  `stopListeningToAnimatedNodeValue` is still in flight to the UI thread.
  Anything the native driver emits in that gap finds no listener, and
  `RCTEventEmitter.m` logs it.
  Nothing in `src/` or `app/` is involved: there is not one core `Animated`
  import in this app — all forty-odd are `react-native-reanimated`, which has
  its own pipeline. It is the second entry in `IGNORED_DEV_LOGS`, argued there
  against the same three-part test as the first, and the pattern names the
  **event** so that `Sending \`onScroll\` …` or any other emitter this app does
  own still comes through.
  **Finding it needed a stack trap, not a log.** The warning is written by
  native, so there is no JS stack at the point it prints, and it reproduces
  perhaps once in twenty-five launches. What names it is patching
  `AnimatedValue.prototype.__ensureUpdateSubscriptionExists` and
  `AnimatedEvent.prototype.__attach` to print their callers — which comes back
  `addListenersToPropsValue < addAnimatedValuesListenersToProps` and the prop
  names `onTransitionProgress` and `onHeaderHeightChange`. And the *fix* is
  verified without the race at all: emit the exact string through
  `console.warn` (native `RCTLogWarn` is routed to the same LogBox path) and
  watch the toast appear and disappear as the pattern is removed and restored.
- **"Can't perform a React state update on a component that hasn't mounted yet"
  on an Android deep-link cold start is expo-router, not this app.** It arrives
  as a red LogBox toast over the first frame, about half a second *before*
  `[bootstrap] database ready` — so it looks exactly like something in
  `src/startup/`, `app/_layout.tsx` or `ConsentGate` writing state during
  render, and an evening went into those before the stack was read. It is none
  of them. `expo-router/build/fork/useLinking.native.js` calls
  `onUnhandledLinking(...)` — which is `setLastUnhandledLink`, a `useState`
  setter on `NavigationContainerInner` — from inside the `.then()` of
  `getInitialState()`, and `getInitialState` runs in the *render* phase. If that
  promise resolves before the container commits, React warns. Still present in
  57.0.19, so there is nothing to upgrade to.
  Three conditions, and it needs all three, which is why it looks intermittent:
  **Android only** — `getInitialURLWithTimeout()` returns
  `ExpoLinking.getLinkingURL()`, a plain string, on iOS, and
  `Promise.race([Linking.getInitialURL(), 150ms])` on Android, so only Android
  has a promise to lose the race with. **A deep link only** — with no initial
  URL the promise resolves `null`, the `typeof url === 'string'` guard fails and
  no setState happens, which is why a plain `am start -n …/.MainActivity` never
  shows it. **A slow first render only** — on a warm launch the tree commits
  before the promise lands. The repro is all three at once: reinstall the APK,
  then `am start -a android.intent.action.VIEW -d 'ridik:///today'`.
  It is cosmetic. React still enqueues the update and applies it when the fiber
  mounts, the deep link routes correctly, and the warning does not exist in a
  release build. **Do not silence it with `LogBox.ignoreLogs`** — `logbox.ts`
  earns its one suppression by matching a full sentence unique to the package,
  so everything else that package says still shows. This message is generic
  React text, and suppressing it would also hide the same warning the day our
  own code causes it, which is a warning worth keeping.
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
- **`@available` on a type makes the `else` of every `#available` guard
  uncompilable, and a typecheck of the arch you happened to pick will not tell
  you.** `SpeechFailureException` holds a `SpeechAnalyzerFailure` and reads two
  strings off it — no iOS 26 API anywhere in it — and marking it
  `@available(iOS 26.0, *)` anyway broke exactly the branch whose job is to
  report "this OS cannot do it": `guard #available(iOS 26.0, *) else { throw
  SpeechFailureException(...) }`. The `else` is the *old-OS* path, so an
  iOS-26-only type is unavailable there. Annotate what actually touches the
  framework and nothing else.
  Two things about finding it. It failed on **x86_64** while
  `swiftc -typecheck -target arm64-apple-ios26.0-simulator` was green — not
  because the arch matters here, but because `generic/platform=iOS Simulator`
  builds both and a hand-rolled typecheck builds one. And it was in
  `RidikSpeechModule.swift`, the one file that *cannot* be typechecked
  standalone because it needs `ExpoModulesCore` — which is the argument for
  keeping that file thin and everything else out of it.
  **A pod target builds on its own, in seconds, and that is the loop to use:**
  `xcodebuild -project ios/Pods/Pods.xcodeproj -target RidikSpeech -sdk
  iphonesimulator -configuration Debug build`. No `-derivedDataPath` (xcodebuild
  demands `-scheme` alongside it), and no twenty minutes of React Native.
- **`expo-modules-core` is mapped to a stub in the `logic` project, and it had to
  be.** It ships untransformed ESM and its only job is to reach a native runtime
  Node does not have, so any logic test that *transitively* imports it dies with
  a bare parse error naming a file this repo never imports directly. It arrived
  transitively the moment `src/voice/stt.ts` reached for Apple's on-device
  analyzer, and took `stt-session.test.ts` and `stt-bias.test.ts` with it —
  two suites with nothing to do with native speech. `jest/expo-modules-core-mock.ts`
  reports the native module as **absent**, which is not a convenience: it is
  what a build without the module compiled in reports, and all three callers in
  `src/` are written for exactly that case. A suite that wants the native side
  *present* supplies its own `jest.mock` with a double.
  **And a module captured at import time cannot be mocked with a getter.**
  `stt-session.test.ts` mocks `expo-speech-recognition` with a `get` accessor,
  which works because `stt.ts` reads its module on every call. `apple.ts` keeps
  the result of `requireOptionalNativeModule`, and babel hoists the test's
  `import` above its own `const` — so returning the double directly hands the
  module `undefined` for the whole run, and it then reports the analyzer as
  absent and every assertion fails for a reason unrelated to what it tested.
  `apple-session.test.ts` returns a **forwarding `Proxy`** instead.
- **`drizzle-orm/expo-sqlite` must be imported from `/driver`.** The package index also exports
  `useLiveQuery`, which pulls in the native module and makes the file unloadable under Node.
- **A `ScrollView` does not clip to its own `borderRadius` on iOS.** Put the
  background and the radius on the scroller and the panel draws correctly while
  its rows scroll straight out past the top of it — onto whatever is behind,
  which on home is the ember. The fix is a plain `View` wrapper carrying the
  ground, the radius and `overflow: 'hidden'`; Android clips to its background
  anyway, which is why this is a defect on exactly one platform and invisible on
  the other. Its vertical padding belongs on `contentContainerStyle` too: a
  `ScrollView`'s own padding scrolls away with the content under it.
- **A `SectionBoundary` turns a crash into a small card, and a test suite goes
  green straight over it.** That is the right behaviour live — the rest of the
  screen still renders — and a trap in a test, because nothing fails. It is also
  the second half of the mocked-hook problem: `home-screen.test.tsx` mocks
  `@/hooks` wholesale, so a component added later that reads a hook the mock
  does not have throws on every render, and all 32 tests passed over a home
  screen displaying *"recent turns could not be shown.
  useInteractionHistory is not a function"*. The guard is one assertion —
  `expect(screen.queryByText(/could not be shown/)).toBeNull()` — matching the
  shape every `SectionBoundary` fallback produces rather than any one label, so
  a section added later is covered without anybody remembering.
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

**The prompt has two budgets, and they used to be one number.**
`prompt-cache.test.ts` bounded prompt *and* schema together with a single
tool-scaled ceiling — `7240 * tools / 28 * 1.05` — which is a model of how the
**schema** grows: one full parameter branch per tool. Prose does not grow with
tool count, so every word added to RULES was silently spending the schema's
headroom, and by the time the conversation rules were written there was none
left: the prompt measured **99.5% of its own ceiling**. The next person to add a
sentence of any kind would have hit it with no idea why a rule about
continuations was failing a test about caching. The two are bounded on their own
terms now — `SCHEMA_TOKENS_PER_TOOL` and `PROSE_CEILING_TOKENS`, both readings
rather than targets, and the assertion that actually matters (the estimate never
comes in *under* what the provider billed) is untouched. The prose budget is a
budget and not a limit: going over is allowed, it just has to be a decision
somebody writes a number down for.

Worth knowing while writing one: the fifteen rules already there average **86
tokens each**. The first draft of three new ones came to 186 each, which is what
made the ceiling bind. Examples are the cheaper way to teach a shape — a
worked input/output pair costs about 80 tokens and does what a paragraph of
prose does — and `FewShotExample.earlier` exists because a *fragment* cannot be
taught by a lone pair at all: "toilet paper" has no right answer without the
turn above it.

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

**And an installed app is not a built one.** `simctl install` of whatever is
still in DerivedData will happily give you a *months-old* binary while Metro
serves today's JavaScript over the top of it — so every screen is current, every
test is green, and the app's own icon is the Expo placeholder. That is how the
blue chevron with its construction guides survived on the simulator long after
`scripts/icons.py` had cut the real mark and `expo prebuild` had copied it into
`ios/Ridik/Images.xcassets`: the asset catalogue was right, the *build* was not.
Nothing in a JS-only change forces a native rebuild, so nothing tells you. The
check is the icon on the springboard, or:

```bash
cp "$APP/AppIcon60x60@2x.png" /tmp/icon.png   # LOOK at it
```

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

  The `AXGroup` is the device screen. It is **not always 1:1** — an earlier
  version of this note said it was, and on a window the user has zoomed it is
  not: a 17 Pro reported 383 × 832 against the device's 402 × 874. Derive the
  scale from the frame rather than assuming it, which also makes the arithmetic
  independent of the zoom:
  `screen = group_origin + point × (group_size / device_size)`.

  **Click with `cliclick`, not with System Events.**
  `tell application "System Events" to click at {x, y}` returns success and does
  nothing — three rounds of it were spent believing the coordinates were wrong.
  `cliclick c:x,y` works, and `cliclick dd:… m:… du:…` is the only way to make a
  *drag*, which is what a scroll is. Two things about that:
  **the Simulator must be frontmost for every click** (`tell application
  "Simulator" to activate`, then one click — batching several after one activate
  lands only the first), and `every UI element of window 1` fails with "Invalid
  index" whenever it is not, which looks exactly like a missing Accessibility
  grant and is not.

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
- **The auto-send flow has not carried a real spoken sentence on either platform, and on iOS it
  cannot be made to.** The store transitions are covered by `review.test.ts` (12 tests, including
  every unmeasured-confidence path), and the *states* have been seen on a device: Android reaches
  `listening` with the new "LISTENING · TAP TO SEND" caption through
  `am start -d 'ridik:///?speak=1'`, which is how to drive the microphone with no tap. What is
  missing is an utterance going in and `onFinal` auto-sending out.
  **The iOS simulator has no speech recogniser at all** — not just the missing `SpeechAnalyzer`
  documented above, but no rung whatsoever: the same deep link renders "This device has no speech
  recogniser. You can type…", which is the degradation working correctly and also the end of what
  a simulator can say about this. So the iOS half is a real iPhone or nothing.
  And the confidence branch is narrower than it looks on iOS: `SFSpeechRecognizer` mostly declines
  to report a number, so `wasPoorlyHeard(null)` is `false` and every sentence auto-sends. That is
  the intended degradation — identical to Android's unmeasured 0/-1 — but it means the composer
  branch only ever fires on an **iOS 26 iPhone with the SpeechAnalyzer model installed**, which is
  the same device the live-microphone path needs. One phone closes both.
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
