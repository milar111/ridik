<p align="center">
  <img src="docs/media/banner.png" alt="Ridik — say it once" width="100%">
</p>

<h3 align="center">Say it once. Ridik files it.</h3>

<p align="center">
  A voice-first organiser for iPhone and Android.<br>
  One sentence becomes a calendar event, a task, a note, a list item or an expense —<br>
  with no account, and your life kept on your phone.
</p>

---

## The idea

Organiser apps make you do the organising: pick the app, find the screen, fill the form.
Ridik is **one microphone**. You talk the way you'd talk to a friend, and it works out
where everything goes.

> *"Remind me to call Ivo at 4, cancel my Math homework for Sunday, and note that the
> robotics lab needs 10k resistors."*

→ **three** separate actions, each reported back, each one tap to undo.

<table>
  <tr>
    <td><img src="docs/media/01-say.png" alt="Just say it"></td>
    <td><img src="docs/media/02-today.png" alt="Your whole day, answered"></td>
    <td><img src="docs/media/03-tasks.png" alt="Tasks with due dates and blockers"></td>
    <td><img src="docs/media/04-timetable.png" alt="Weekly timetable"></td>
  </tr>
  <tr>
    <td><img src="docs/media/05-money.png" alt="Money, by the sentence"></td>
    <td><img src="docs/media/06-habits.png" alt="Habit streaks"></td>
    <td><img src="docs/media/07-notes.png" alt="Searchable notes and lists"></td>
    <td><img src="docs/media/08-private.png" alt="It stays on your phone"></td>
  </tr>
</table>

## What it does

| You say | Ridik does |
| --- | --- |
| "dentist Tuesday at three" | Adds it to your calendar, and warns you if it clashes with something |
| "what does my day look like" | Reads back what's next, what's late and what you promised |
| "I can't solder the board until the bearings arrive" | Links the two tasks; the blocked one waits until it's unblocked |
| "homework for Math, page 42" | Due the day before your next Math class — it knows your timetable |
| "spent fifteen forty on lunch" | Logs €15.40 under Food |
| "log my reading" | Keeps your streak going |
| "find the wifi password" | Searches your notes |

Plus a daily spoken briefing, location reminders, focus timers, people & promises, and
**home-screen widgets on both platforms** with a mic button that starts recording directly.

## Built to be trusted

- **It shows its work.** Every turn ends with a receipt of exactly what changed, with Undo.
  Anything irreversible asks first — and if it isn't sure what it heard, it asks rather than guesses.
- **No account. One file on your phone.** Export it any time; restoring a backup only ever
  *adds*, never overwrites.
- **Honest about the network.** Before anything leaves the phone, a first-run screen names every
  company that could receive data and what they get. Say no and the app still works — an
  offline engine files simple sentences on-device.
- **On-device speech where possible.** Apple's `SpeechAnalyzer` on iOS 26, and a local
  whisper.cpp model as an upgrade that transcribes without uploading audio.
- **Free where it's free.** Everything local is free forever. Only requests to the AI model are
  metered — 25 free to try, then a small monthly plan.

## Pricing, and why it is these numbers

Ridik has one cost that grows with use: each time you talk to the assistant, the app makes a call
to the AI model. Everything else runs on your phone and costs nothing to run. So the rule is simple:
**everything local is free, forever, and only requests to the model are paid for.** Your calendar,
tasks, notes, lists, habits, money, widgets, exports and the offline voice engine never sit behind
a paywall. If you stop paying, you keep everything you have written.

| | Price | Requests to the assistant |
| --- | --- | --- |
| **Free** | — | 25 in total, then the offline engine |
| **Ridik** | $5 / month, or $49.99 / year | 250 a month (roughly 8 a day) |
| **Ridik Pro** | $10 / month, or $99.99 / year (shown as $8.33 / month) | 1,000 a month (roughly 30 a day) |
| **Top-up** | $3, one-off | 100 extra, never expire |

Sold through RevenueCat on the App Store and Google Play. One entitlement, `assistant`, covers
four subscriptions (`ridik_monthly`, `ridik_yearly`, `ridik_pro_monthly`, `ridik_pro_yearly`) and
one consumable (`ridik_topup_100`).

### Where the numbers come from

- **The model is fixed first, then the price.** The app is pinned to `gemini-3.1-flash-lite`,
  which costs $0.25 per million input tokens and $1.50 per million output tokens. A typical turn
  was measured at about 3,240 tokens in and 600 out, so one request costs roughly **$0.0017**. If
  a Pro subscriber uses all 1,000 requests, they cost about **$1.93** (repairs included), so even
  the heaviest user of the biggest plan is comfortably sustainable. The model is an exact version,
  never a moving alias ([`provider/gemini.ts`](src/llm/provider/gemini.ts)): an alias can change
  model, and price, without a release, and every number on this page depends on it staying put.
- **Twice the money for four times as much.** $5 for 250 is 2¢ a request, and $10 for 1,000 is 1¢.
  Prices are round on purpose: anyone can do that division in their head, which $4.99 / 250
  doesn't allow.
- **250 is set so the limit actually happens.** It sits near the 88th percentile of modelled
  usage, so about one Ridik subscriber in eight reaches it in a given month and sees the Pro
  offer — often enough to matter, rare enough that most people never think about a limit.
- **There is no unlimited tier.** Every plan has a real ceiling, so the cost of any subscriber
  is bounded. Limits are their own type rather than a number, so "unlimited" can never be
  confused with "nothing bought" ([`entitlement.ts`](src/services/billing/entitlement.ts)).

### The free trial is a lifetime allowance, not a monthly one

A free monthly allowance is really a subscription that nobody is charged for: wait until the 1st
and it fills back up. Ridik's 25 free requests are **per install, for life**, and only a plan
restores them. A stranger's worst-case cost is therefore fixed at a few cents.

- **Counted in requests and in tokens.** A single request can be a 4,000-token turn or a
  huge pasted paragraph, so the trial also has a token limit: 25 × a typical turn × 4 headroom,
  about 384k tokens. The first limit reached ends the trial. The headroom exists because a reply
  that fails validation gets repaired, and a single honest turn can bill up to three times.
- **Hard to reset.** The counter lives in SQLite *and* in the secure keychain, and the app reads
  whichever number is higher. "Erase everything" deliberately keeps it, and on iOS so does a
  reinstall. A test reads the source code and fails if any new way to lower it appears
  ([`reset-surfaces.test.ts`](src/services/billing/__tests__/reset-surfaces.test.ts)).
- **Announced before it is used up.** The limit is shown on the first-run disclosure and on the
  Settings plan row ("N of 25 free requests left"), and you get a warning with every request
  once 5 are left.
- **Running out does not break the app.** When the trial or a plan runs out, voice keeps working
  through the offline engine, which recognises reminders, expenses, list items and searches, and
  saves anything else as a note. Each turn then tells you this happened, because an assistant
  that gets quietly less capable is the one failure this app is built to avoid.

### The top-up costs more per request, on purpose

100 requests for $3 works out to 3¢ each, against 1¢ on Pro. Pay-as-you-go should cost more per
unit than committing to a month; a top-up priced below the plans would make the plans pointless.
It exists for the month you go over, not as a cheaper way in, which is why it is drawn *below*
the plans on the paywall. Credits are only spent after the plan or trial runs out, so buying one
never wastes what you already have. They are a balance, not a monthly rate: adding them to a
monthly ceiling would refill them every month ([`credits.ts`](src/services/billing/credits.ts)).
The count of credits bought comes from RevenueCat and is never written by the app. The count
spent is kept in two places and the app reads the higher of the two, so editing the database
can't increase your balance and clearing it can't refund anything.

### Never charge someone for the app's own failure

- **"Free" and "we couldn't reach the store" are different answers.** If reading the entitlement
  fails, the result is `UNKNOWN`: no lock, no trial charge, and no message about money. Treating
  a network blip as "not subscribed" would lock paying users out of the service they paid for
  ([`allowance.ts`](src/services/billing/allowance.ts)).
- **Limits are a type, not a number.** A limit always travels as a `Cap`. Only `developerCap()`
  may read `0` as "no limit", and `limitOf(0)` refuses every request. Only one function,
  `resolveAssistantBudget()`, decides who may spend. The usage meter then only measures what has
  been spent, and nothing sits between the two.
- **Estimate high, then reconcile.** Before a call, the app estimates its cost from this user's
  own recent average, rounding towards refusal. Afterwards it records what the provider actually
  billed. A needless offline answer costs less than an uncapped call.
- **You pay for what you asked, not for the app's retries.** `requests` counts what you said.
  `calls` counts what the provider billed, including repairs. Plans are sold in requests, so
  repairs never count against you.
- **The clock only moves forward.** The usage window uses the later of today's date and the
  newest date ever recorded, so setting the phone's clock back can't open a fresh month.
- **Plan changes are fair.** Upgrades take effect now with a prorated charge. Downgrades are
  deferred, so you keep what you paid for until the period ends. Switching monthly ↔ yearly on
  the same tier uses time proration ([`revenuecat.ts`](src/services/billing/revenuecat.ts)).
- **A paywall that can't load says why.** If a store key is wrong for the platform, the app names
  the problem and the key prefix that platform needs, instead of blaming the store.

The app is also ready for web checkout (Stripe → a deep link back into the app → a backend that
grants the same RevenueCat entitlement), so a web purchase is just another reason for the one
entitlement to be active, never a second source of truth
([`webFunnel.ts`](src/services/billing/webFunnel.ts)).

## Under the hood

**Expo SDK 57 · React Native · TypeScript · SQLite + Drizzle · Gemini (behind a swappable
provider) · native Swift & Kotlin widgets · RevenueCat**

- The model never touches the database directly — it proposes typed actions (validated with Zod)
  and a local executor applies them.
- Ambiguous matches return *"I don't know"* instead of a best guess, so a misheard name can't
  silently edit the wrong thing.
- 150+ test files, with the data layer tested against real SQLite rather than mocks.

Running it, the architecture and the design rules: **[DEVELOPING.md](DEVELOPING.md)** ·
[AGENTS.md](AGENTS.md) · [WIDGETS.md](WIDGETS.md) · [Privacy policy](docs/privacy.md)

## Licence

Copyright © 2026 Daniel Yordanov. Licensed under the
[GNU Affero General Public License v3.0](LICENSE): you can read, run and modify
the code, but anything you distribute or host that is built on it has to be
released under the same licence, with its source.
