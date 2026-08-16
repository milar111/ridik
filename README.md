<!--
  IMAGES ARE NOT IN YET.

  Every picture below is written out and commented out, waiting for a
  screenshot. The interface is still moving and a screenshot of a screen that
  is about to change is worse than none.

  docs/media/SHOTS.md is the shot list: what each image must contain, how to
  set the simulator up, and which pairs have to be shot at matching sizes.
  When a shot exists, save it at the path in the image line and delete the two
  comment markers around it. Nothing else needs editing.
-->

# Ridik

**A voice-first personal organiser for iOS and Android. You talk; it files.**

One sentence can create a calendar event, cancel another, append a bullet to a note and add three
items to a shopping list — in one pass, on-device, with no account.

<!-- SHOT: hero
![Ridik's home screen: a single microphone on a warm ember field](docs/media/hero.png)
-->

```
"Remind me to call Ivo at 4, cancel my Math homework reminder for Sunday,
 and note down that the robotics lab needs 10k resistors."

    → calendar_add      { title: "Call Ivo", start: "…T16:00" }
    → calendar_delete   { target: { query: "Math homework", on_date: "…" } }
    → note_update       { target: { query: "robotics lab" }, append_bullets: ["10k resistors"] }
```

Three actions, one breath, three separate results — and if one of them fails the other two still
land.

---

## The whole app is one screen

A microphone, the next thing on your calendar, and a receipt for the last thing it did. Everything
else is behind the hamburger. There is no tab bar, no feed, and nothing to scroll on the screen you
open forty times a day.

| Listening | The receipt |
| --- | --- |
| <!-- SHOT: home-listening ![The mic listening, caption replaced by a live partial transcript](docs/media/home-listening.png) --> | <!-- SHOT: receipt ![One sentence, three actions, three separate results, each undoable](docs/media/receipt.png) --> |

**The receipt is the safety model.** Speaking is fast because you do not have to look — which is
exactly why a misheard word would otherwise land silently and stay wrong. Every turn reports what it
actually wrote, and anything that created exactly one row can be undone from the card.

Speaking is not always possible, so holding the microphone opens a keyboard instead. The hold draws
its own progress, and the sheet squares off against the keyboard so the two read as one surface.

| Hold to type | Typing |
| --- | --- |
| <!-- SHOT: hold-to-type ![A ring closing onto the mic disc partway through a long press](docs/media/hold-to-type.png) --> | <!-- SHOT: sheet-typing ![The compose sheet flush against the keyboard](docs/media/sheet-typing.png) --> |

---

## It knows enough to be useful

<!-- SHOT: today
![The day as one scroll: classes, calendar, a travel block sitting in front of an event, what is due](docs/media/today.png)
-->

**Travel time is blocked before anything you have to get to.** Anything with a location — or
classified as an exam — gets a 20-minute block in front of it. The block follows the event when it
moves and disappears when it is cancelled.

**Your timetable is context.** "Homework for Math, page 42" lands the day before your next Math
class, without being told when that is.

**Double-booking asks first.** Booking or moving onto an occupied slot offers the next free one
rather than quietly stacking two things at 15:00.

<!-- SHOT: tasks-graph
![A dependency chain: blocked work hidden behind what unlocks it](docs/media/tasks-graph.png)
-->

**Work that depends on other work.** "I can't start assembly until the frame is printed and the
servos arrive" builds a real graph. Blocked tasks stay out of today's list until they unlock, and a
cycle is refused rather than deadlocked.

<!-- SHOT: notes
![Structured notes with a checklist section, tags, and full-text search](docs/media/notes.png)
-->

Notes, lists and checklists with FTS5 search, a micro-ledger, habits with streaks, a small CRM of
people and the promises you made them, geofenced reminders, and focus sessions that survive the app
being killed.

<!-- SHOT: menu
![Every destination in the app, on one page](docs/media/menu.png)
-->

---

## A briefing, spoken

<!-- SHOT: briefing
![Today, tomorrow and this week, with a fifteen-second spoken summary](docs/media/briefing.png)
-->

Fifteen seconds, built from everything above, waiting the first time you open the app each day.

---

## On your home screen

Five widget faces per platform — Today, Agenda, Tasks, Habits and a List — and a microphone on the
medium and large ones that starts a recording without opening the app.

| iOS | Android |
| --- | --- |
| <!-- SHOT: widgets-ios ![WidgetKit faces on an iOS home screen](docs/media/widgets-ios.png) --> | <!-- SHOT: widgets-android ![The same faces on an Android home screen](docs/media/widgets-android.png) --> |

Each widget runs in its own process and can only read what the app published, so one payload feeds
all ten faces. `WIDGETS.md` is the contract.

---

## Your data stays yours

<!-- SHOT: consent
![The first-run screen naming every service that receives anything](docs/media/consent.png)
-->

Everything lives in **one SQLite file on your phone**. No account, nothing to sign in to, no
analytics.

Turning speech into filed data needs a language model, so the words of your request and a short
index of your own labels go to Google. **What is inside a note never leaves.** Nothing is sent until
you have read that screen and agreed to it, and declining leaves a working app — the offline matcher
still files a plain sentence.

Every outbound path is named on that one screen: the model, the speech recogniser, optional Whisper
transcription, and the briefing notification. Adding a fifth means adding a sentence there, and a
test fails if it is missing.

**A backup that can come back.** Settings → Your data writes every row to one JSON file and restores
it onto any install. Restoring **merges** — it adds what is missing and never deletes or overwrites
what is already there — and it tells you which it is going to do before it runs.

---

## Plans

| The paywall | Once you have one |
| --- | --- |
| <!-- SHOT: paywall ![Two tiers, a billing toggle, and the per-month price of each](docs/media/paywall.png) --> | <!-- SHOT: plan-active ![The subscribed screen, stating the allowance the plan buys](docs/media/plan-active.png) --> |

Everything local is free and unlimited — notes, tasks, timers, the timetable, the widgets. What is
metered is the part that costs money to run: a request to the model.

| | Monthly | Yearly | Included |
| --- | --- | --- | --- |
| **Ridik** | $5 | $4.17/mo | 250 requests a month |
| **Ridik Pro** | $10 | $8.33/mo | 1,000 requests a month |

A $3 top-up adds 100 requests that never expire and are spent only after your plan or trial has run
out. Prices come from the store, in your own currency; the numbers above are the US ones.

---

## Dark mode is designed, not inverted

| Light | Dark |
| --- | --- |
| <!-- SHOT: hero-light ![The home screen in light mode](docs/media/hero.png) --> | <!-- SHOT: dark ![The same screen in dark mode, re-solved rather than flipped](docs/media/dark.png) --> |

The palette is a warm ground lit as though the microphone were the heat source. Every "black" is a
warm brown and every "white" is linen; a true grey next to it reads as a bug. A test measures the
palette as a set — contrast on both grounds, a saturation ceiling, hue separation — because the
failure mode of a colour system is that each colour is defensible and the set is not.

---

## How it is built

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

`AGENTS.md` records the rest — every invariant, and every trap that has already cost a debugging
session.

---

## Running it

```bash
npm install
npx expo prebuild            # regenerates ios/ and android/ from app.config.ts
(cd ios && pod install)      # prebuild --no-install skips this and deletes the workspace

npx expo start               # Metro

npm run ios

export JAVA_HOME="$HOME/.jdks/temurin-21/Contents/Home"   # JDK 25 fails the CMake step
npm run android
```

Requires Node 20+, Xcode 26+ with an iOS 26 simulator, the Android SDK with platform 36, and **JDK
21**. This is a bare debug build rather than Expo Go — `expo-dev-client` is deliberately absent
because its launcher needs a manual tap that blocks automated verification.

### Configuration

**Nothing secret is committed.** The Gemini key is entered in the app and stored in the device
keychain, never in the database and never in the bundle — anything prefixed `EXPO_PUBLIC_` is
readable inside the shipped `.apk`. Everything below is a publishable identifier, and every
subsystem no-ops when its value is missing rather than failing:

```bash
EXPO_PUBLIC_REVENUECAT_IOS_KEY=appl_…      # unset → a local sandbox that sells nothing
EXPO_PUBLIC_REVENUECAT_ANDROID_KEY=goog_…
EXPO_PUBLIC_REVENUECAT_ENTITLEMENT=…       # unset → `assistant`
EXPO_PUBLIC_ONESIGNAL_APP_ID=…             # unset → no remote push
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=…         # unset → no calendar sync
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=…
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=…
```

`DEPLOY.md` has the dashboard steps.

### Testing

```bash
npm test              # 117 suites, 2,180+ tests
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
apps are a separate, manually-triggered workflow, because a native build is twenty minutes to prove
something the simulators already showed.

---

## Licence

MIT. See `LICENSE`.
