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

**Say it once. Ridik files it.**

A voice organiser for iPhone and Android that turns what you say into calendar
events, reminders, tasks, notes and lists — without an account, and without
your life leaving your phone.

<!-- SHOT: hero
![Ridik's home screen: a single microphone on a warm ember field](docs/media/hero.png)
-->

> **"Remind me to call Ivo at 4, cancel my Math homework reminder for Sunday,
> and note down that the robotics lab needs 10k resistors."**

Three things, one breath:

- **Call Ivo** goes in your calendar at 16:00
- **Math homework** on Sunday is cancelled
- **10k resistors** is added to your robotics lab note

Each one is reported separately, and if one of them does not work the other two
still happen.

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

Notes, lists and checklists you can search by typing or by asking. Somewhere to
track what you spend. Habits with streaks. The people you know and the things
you promised them. Reminders that go off when you *arrive* somewhere rather than
at a time. And focus timers that keep counting even if the app gets closed.

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

They update themselves as your day changes, and they work without opening the
app at all.

---

## Your data stays yours

<!-- SHOT: consent
![The first-run screen naming every service that receives anything](docs/media/consent.png)
-->

Everything lives in **one file on your phone**. No account, nothing to sign in
to, no tracking.

Understanding a sentence needs help from a computer that is not your phone, so
the words you said — and a short list of your own labels, like the names of your
lists and the people you know — go to Google. **What is written inside a note
never does.** Neither does what anything cost, a phone number, an address, or
where you have been.

Ridik shows you that screen before it sends anything, ever, and names every
service that receives something. Saying no leaves a working app.

**A backup that can actually come back.** Your whole app, as one file you can
keep anywhere. Putting it back *adds* what is missing and never deletes or
overwrites what is already there — and it tells you which before it starts.

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

The screen is lit as though the microphone were warming it. Nothing in Ridik is
plain grey — every dark is a warm brown, every light a soft linen — and the dark
mode is drawn from scratch rather than flipped, so it stays warm at night
instead of turning into a black rectangle.

---

## Questions people ask

**Do I need an account?**
No. There is no sign-up, no email, no password. Open it and talk.

**Where does my stuff live?**
In one file on your phone. It is included in your phone's own backup, so if you
have iCloud or Google backup switched on there is a copy in your account — and
it comes back when you set up a new phone.

**Does anything leave my phone?**
To turn what you say into filed things, the words of your request and a short
list of your own labels — the names of your lists, projects and people — go to
Google. What is *inside* a note never does. Neither does what anything cost, a
phone number, an address, or where you have been. Ridik asks before it sends
anything the first time you open it, and tells you exactly what goes.

**What if I say no?**
The app still works. It hears you and files plain sentences on its own —
"spent 12 on lunch", "remind me to call Ivo at four", "add milk to my shopping
list" — with nothing leaving the phone at all. It just cannot understand the
complicated ones.

**Can I get my data out?**
Yes, whenever you like, as one file you can read. Putting it back merges: it
adds what is missing and never deletes or overwrites what is already there, and
it tells you which before it does anything.

**What if it mishears me?**
It shows you what it did, every time, and one tap undoes it. Before it does
anything it cannot take back, it asks first.

**Is it free?**
Everything on the phone is — notes, tasks, timers, your timetable, the widgets,
for ever. What costs money is the part that listens and understands, because
that runs on somebody else's computer. You get 25 free requests to try it.

---

## For developers

The stack, the architecture and how to run it are in **[DEVELOPING.md](DEVELOPING.md)**.
`AGENTS.md` has the invariants and every trap that has already cost a debugging
session; `WIDGETS.md` is the widget contract.

## Licence

MIT. See `LICENSE`.
