# Ridik widgets — the contract

Two platforms draw **fourteen** faces from one published payload, and iOS draws a
fifteenth on the Lock Screen (§7c — the one place the family is deliberately not
symmetrical, and §7b says why). Nothing is shared between them at build time: an Xcode extension links neither the app nor
React Native, and an Android widget is XML replayed by the launcher. So this
file is the shared source, and it is normative. Where the code and this file
disagree, one of them is a bug.

Read `AGENTS.md` → **Widgets** first for what will bite you. This is the *what*;
that is the *why it breaks*.

---

## 1. The primitive

Every graphic in the family is **one cell**: a rounded rectangle, corner radius
2pt, filled with the single ember colour at one of four opacities.

The ember is **chosen by the user** — Profile → Colour, defaulting to `ember`,
which is the ramp below. The other options live in `src/ui/theme.ts` → `embers`
and every one of them is held to the rules in this section by
`src/ui/__tests__/widget-tokens.test.ts`. Adding a fourth means adding it there,
and the test is what stops one being added that nobody can read.

| Level | Char | Light | Dark | Means |
| --- | --- | --- | --- | --- |
| cold | `0` | `#F2CBBD` | `#4F2216` | nothing here |
| low | `1` | `#E59E89` | `#82321F` | a little |
| mid | `2` | `#D86F52` | `#B84329` | claimed / done |
| hot | `3` | `#C7360F` | `#FF5A36` | **the one urgent thing** |

These are the default ember composited over `tile` at 23 / 46 / 71% (light) and
24 / 46 / 70% (dark) — the arithmetic in `theme.ts` → `embers`, done once. The
three surfaces below hold these exact strings and `widget-tokens.test.ts` fails
if any of them drifts; this table used to carry a ramp solved against the app's
`bg` rather than the widget's `tile`, which is the ground the family is actually
drawn on.

Defined once per platform — `src/ui/theme.ts` (`cells`),
`RidikPalette.swift` (`heatCold`…`heatHot`), and the plugin's
`ridik_widget_heat_0..3`. `src/ui/__tests__/widget-tokens.test.ts` asserts all
three agree and that the ramp keeps its own rules.

**Three invariants. Breaking any of them breaks the family.**

1. **`hot` marks today, and only today.** One cell on the plate, the next thing
   on the element, the oldest debt on Tasks — one per tile. The habit rails are
   the single exemption: their hot cells are the *last column*, one per habit
   kept today, and a column is one thing however many rails it crosses. Six of
   them is still under two percent of the tile. What the rule actually forbids
   is hot appearing in two *places*, which is what leaves a tile with no focus.
2. **Ink sits on `0`–`2`; on `3` it inverts to `onHeat`.** Ink on hot measures
   3.2:1. Never draw it.
3. **Past cells burn down** — same level, **38% height, bottom-aligned**. The
   step in the silhouette *is* the now-marker; there is no playhead line. This
   is what lets a face survive Android's 30-minute update period: a boundary
   twenty minutes stale looks fine, a labelled rule twenty minutes stale looks
   broken. It is also why an empty tile is still worth looking at.

**Banned across the family**, because they are what makes a design look
machine-made: progress rings, gradients and glows, hairline separator rules,
big-number-with-caption as a whole face, three evenly spaced stat pills, and any
second hue. There is no green and no blue anywhere in these widgets.

**The one narrowing, and it is a narrowing rather than a repeal.** §3.7 *Rings*
draws a proportion as a stroked arc, which the paragraph above forbids. It exists
because the user asked for it after seeing the same encoding on the Habits
*screen*, and the two are not the same argument: a screen is read at arm's length
by someone who opened it deliberately, where a proportion beats a bucket; a tile
is glanced at across a room, where a ring is a smear and four discrete levels are
not. So the rule now reads: **no face may draw a proportion as its graphic unless
the user chose that face over one that does not.** Rings is offered *beside*
Habits and never instead of it, and no other face may take a ring without the
same argument being made again here. `Tank` and `Lens` remain unbuilt on exactly
this reasoning — a ban that bends once per request is not a ban.

**The second narrowing, and it is a distinction rather than a second exception.**
§3.14 *Sundial* draws a curve with a disc riding it, which reads at a glance like
the ring the paragraph above bans. It is not one, and the rule that separates
them is one sentence: **a path carrying a position marker is permitted; a closed
ring encoding a fraction is not.** A progress ring says "62% of a goal" and
invites you to compare two of them side by side. Sundial says "you are here,
between these two ends", which is exactly what the burn-down step in invariant 3
already says — drawn so that it can be read across a room instead of found. The
test is whether anything on the face encodes a *proportion*: on Sundial nothing
does, and on Rings the whole face does, which is why the two needed different
sentences.

---

## 2. Sizes

iOS content area after the system's 12pt inset:

| Family | Content |
| --- | --- |
| `.systemSmall` | 131 × 131 |
| `.systemMedium` | 305 × 131 |
| `.systemLarge` | 305 × 321 |

Android has no families. Pick from the launcher's reported dp inside the 12dp
root padding — `OPTION_APPWIDGET_MIN_WIDTH` and `OPTION_APPWIDGET_MIN_HEIGHT`,
read per widget id in `drawRows`:

```
width < 250dp                    → small
width >= 250dp and height < 170  → medium
otherwise                        → large
```

RemoteViews cannot set a width, a height or a column count at runtime, so each
size is its own generated layout variant — the same mechanism as
`ridik_rows` / `_ampm` / `_tight`.

### How a face answers the rectangle it is given

Four rules. Every visible sizing failure the family has had broke one of them,
so they are worth stating rather than re-deciding per widget.

**1. A cell has a size. Extra space buys more cells, or more air — never fatter
cells.** The rails first divided the tile's height between six of them with
`layout_weight`, so a tile made twice as tall drew bars twice as thick: a chart
whose thickness means nothing, stretched. Rails are now a fixed height and the
slack collects in a spacer at the bottom. The same rule is why the day element
folds 32 cells into 8 on a small tile rather than drawing 32 fat ones.

**2. Text is dropped, never truncated.** A habit called "Reading" rendered as
"Readi…" identifies nothing, and the rail *is* its name. So the gutter is sized
to hold a real word and the columns give way instead: below 260dp the board
shows one week, not five. `best` is dropped first, then `streak` — a number you
can live without, a name you cannot.

**3. A face is sized by the axis it actually grows along.** Habits gains
*columns* with width and only air with height, so it is bucketed on width alone;
promoting it to the five-week layout because the tile was tall is what put
thirty-five hairline columns beside a forty-dp gutter. Every other face gains
rows with height and is bucketed on both.

**4. A widget must be able to fill the grid.** `maxResizeWidth` was 400dp, which
on a 411dp phone is *almost* the screen — so the calendar could never quite
reach the edges, and a tile that stops just short of full width reads as broken
rather than as small. It is 800dp now, on every face, in both axes.

### And when there is nothing in it

The resting cell sits at 23% of the ember, not the 14% that looked right in
isolation: 1.39:1 against its own tile rather than 1.22:1. At 14% an empty board
is a plain card with a suggestion of grid on it. The extra presence costs 0.3 of
a lightness step between the four levels, which is the correct trade — the empty
tile is the state the family is judged on, and nobody ever sees two adjacent
levels side by side to compare them.

---

## 3. The faces

Legend: `░`=0 `▒`=1 `▓`=2 `█`=3, `▁`= spent (38% height).

### 3.1 Today — small, medium

```
┌ medium · 305×131 ─────────────────────────────────────────────┐
│ TODAY  THU 13                                    2 LATE       │ 16
│ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁░░░░░░▓▓▓▓█░░░░░░░   32 cells, gap 2            │ 34
│ 07        11        15        19        23                    │ 11
│ 15:00  Materials lab                                          │ 30
│ leave in 34 min · Studio 2                                    │ 14
└───────────────────────────────────────────────────────────────┘
```

- The element spans `day.startMinute` for `day.load.length` cells of
  `day.cellMinutes`. Draw `day.load` character by character. Where
  `day.breaks[i] === '1'` **and** `i > 0`, leave a 2pt gap of ground before the
  cell — without it two back-to-back meetings read as one long block.
- **Small buckets the same strip into 8**, each the *maximum* of its four cells,
  spent only when all four are past. Never a different day window — the axis
  labels must still read 07 / 11 / 15 / 19 / 23.
- Header right slot shows **one** number, in strict priority: overdue → due
  today → habits fraction. Never two.
- `leave in 34 min` is live: `Text(_:style:.timer)` on iOS, `Chronometer` with
  `setChronometerCountDown(true)` on Android. The only genuinely live element
  either platform gives for zero wakeups.
- Tap → `ridik:///today`.

### 3.2 Calendar — small, medium, large

Was Agenda. **Keep `kind: "RidikAgendaWidget"` and
`RidikAgendaWidgetProvider`** — Android and iOS both identify a widget by that
string, so changing it orphans every already-placed tile. Only the display name,
description and view change.

**Small — the month plate.** Answers "is the 19th free?"

```
┌ small · 131×131 ───────────────┐
│ AUGUST                         │ 14
│ M   T   W   T   F   S   S      │ 12   ← 9pt, inkSoft
│ ░   ░   ░   ▒   ▓   ░   ░      │
│ ▒   ░   ▓   ░   ░   ░   ░      │ 6 rows × 15.5, cells 17×15.5, gap 2
│ ░   ▓   ░   █   ▒   ░   ░      │ █ = today, ringed
│ ░   ░   ▒   ░   ▓   ░   ░      │
│ ▓   ░   ░   ░   ░   ▒   ░      │
│ ░   ░   ·   ·   ·   ·   ·      │ · = out of month → INVISIBLE, never GONE
└────────────────────────────────┘
```

No numerals at this size — 10pt digits in a 17pt cell are unreadable at arm's
length, and the shape of the month is what is being read.

**Medium — the day, listed.** The element, the axis, then up to 3 agenda rows
(`HH:mm  title` with the location right-aligned when it fits).

**Large — both**, plate with numerals (cells 41×25, gap 3, numeral 13pt inside
the cell), then whitespace, then the element, axis and rows. **No rule between
them.** 25 and not 26: the extra point clipped the last agenda row on the
shortest large tile, and a row cut through the middle reads as a rendering
fault rather than as a full tile.

**Row capacity drops by one when there is an all-day line**, on both medium and
large. The line costs about 18pt and the arithmetic has to know.

- Plate load uses `0`/`1`/`2` only; `3` is today and today only. The builder
  already guarantees this.
- **On large, the element takes the hot cell and the plate does not.** Both
  faces have a candidate and only one may win: the element's is the next thing,
  which is actionable, and the plate's is today, which the reader already knows.
  Today on the large plate keeps its ring and draws at its own load level. On
  small there is no element, so today is hot *and* ringed. Note that a hot plate
  cell would also swallow its own ring in light mode — the ring colour and the
  hot fill are both `#C7360F`.
- **The day-of-month is recomputed on the device**, in `snapshot.zone`. Only
  `month.load` is inherited from the payload. `month.today` is a publish-time
  number and goes stale the moment the day turns; trusting it hot-fills the 5th
  on the 13th, on the one face that is supposed to survive a week untouched.
- `month.today` is the day-of-month, or `0` when the plate is not the current
  month.
- Out-of-month cells are **`INVISIBLE`, never `GONE`** on Android — a `GONE`
  child is dropped from `LinearLayout` weight distribution, so the first and
  last weeks would get visibly wider columns than the four between them. `GONE`
  is correct only for an entirely unused sixth row.
- Staleness is **three** branches, not one. Keep "nothing published" and "wrong
  version". Then: the *plate* is stale only when `month.month` is not the
  current month, and the *element and rows* only when `day.date` is not today —
  both computed with `snapshot.zone`, never the device's. This is the only Ridik
  widget that stays honest a week after the app was last opened.
- All-day events: draw `allDay[0]` as a line under the header when present.
- Tap → `ridik:///calendar`.

### 3.3 Habits — small, medium

```
┌ medium · 305×131 ─────────────────────────────────────────────┐
│ HABITS                                            4/6         │ 16
│          M T W T F S S M T W T F S S M T W T F S S            │ 10
│ Run  12d ░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓█   cells 10×12, gap 1.4         │
│ Read  4d ▓░░▓▓░░▓▓▓░░▓▓▓▓░░▓▓█   gutter 62                    │ 6 rails
│ Water    ░░░░░▓▓░░░▓▓▓░░▓▓▓▓▓▓░                               │ × 17.5
│ Stretch  ░░▓░░░░▓░░░░▓░░░░▓░░░░                               │
│ Journal  ▓▓░░░▓▓░░░▓▓░░░▓▓░░▓░                                │
│ Vitamin  ░░░░░░░░░░░░░░░░░░░░░                                │
└───────────────────────────────────────────────────────────────┘
```

- **Window: 7 / 21 days.** Take the *last* N characters of
  `habits.rows[].history`, which is 35 long and ends on `day.date`. The 35-day
  board went with the large size: six rows cannot grow to meet 321pt of height,
  so the extra bought ground rather than cells — §2 rule 1 exactly. Android caps
  `railSizeOf` at medium so a wide tile cannot ask for a layout that is no
  longer generated.
- Levels are **binary**: `'0'` → cold, `'1'` → mid, **and the last cell, if
  `'1'`, is hot**. If today is not done there is no hot cell on the tile, and
  that absence is the message.
- **Cells are vertical bars, not squares.** Width is the constrained axis and
  height is free, so buy the readable dimension with the one you have.
- Names live in a **left gutter**, never above the rail. The cross-habit read —
  "everything dies on a Sunday" — is a vertical read down aligned columns, and a
  name line between rails destroys it.
- Streak in the gutter only when > 1 (`12d`).
- **Always draw all six rail slots**, whether or not a habit exists for them. A
  board occupies its rectangle at zero habits; a list does not. The empty slots
  teach the capacity without a word.
- Rows arrive in creation order and must be drawn in it. See
  `snapshot.ts` → `habits.rows`.
- Tap → `ridik:///habits`.

### 3.4 Tasks — small, medium

```
┌ medium · 305×131 ─────────────────────────────────────────────┐
│ TASKS                                            2 LATE       │ 16
│ █▓▒░░░░░░░░░   one cell per open task, gap 2, oldest left     │ 24
│ oldest 9d                                     12 open         │ 12
│ 9d     Return the drill to Sam                                │ 22
│ 2d     Email the tutor about the resit                        │ 22
│ 17:00  Submit the parts form                                  │ 22
└───────────────────────────────────────────────────────────────┘
```

- **The axis is age, not clock time.** `due` in the tool contract is a full
  `YYYY-MM-DDTHH:mm`, so the model invents an hour whenever the user did not say
  one; plotting that as a position would render fiction as data. How late
  something is was never guessed.
- Debt cells come from `tasks.ages` — already oldest-first. Level: `0` days →
  cold, 1–2 → low, 3+ → mid, and **the single oldest overdue → hot**. Cap 12
  (small) / 24 (medium); the true count goes in the footer.
- Row lead is `9d` / `2d` for overdue, else the time. Never the word "late" —
  the payload has always carried the real date.
- Tap → `ridik:///tasks`.

### 3.5 List — small, medium, large

The quiet one. **No cells, by decision** — a checklist has no time axis and
inventing one would be decoration. One tile without a graphic is what makes the
other five read as chosen rather than as a house style applied everywhere.

Header is the list name and `4 OF 12`. Rows are `○` / `✓` and the text, open
first, done struck through in `inkSoft`. The marks are cold-filled 7pt cells
with a 1pt ground inset — the family's primitive at its quietest.

Tap → `ridik:///notes?pane=lists&list=<urlencoded name>`.

**Large, and why this face gets one when Today does not.** Four rows on small,
five on medium, **eleven on large** — 321pt holds that many at 20pt with the
header. Today's large would be the medium face with air around it, but a
shopping list is the one thing on a home screen you want *all* of, and a list
you cannot see the end of is a list you still have to open the app for.

It is the only face that draws more than six rows, so it is the only one whose
payload carries more: `LIST_ROW_CAP` in `snapshot.ts` is 11 while `ROW_CAP`
stays 6, and the slots are generated per-kind — `LIST_ROW_SLOTS_BY_SIZE` in the
Android plugin, `Slots.listRows` in `RidikCells.kt`. Raising the shared number
instead would write five permanently hidden views into every agenda, tasks and
habits layout, because RemoteViews cannot loop. Row *count* is not payload
*shape*, so this needs no `WIDGET_SNAPSHOT_VERSION` bump: every face already
slices the array to its own slots, and an older widget handed a longer one draws
its own number of rows and no more.

**Done rows are rationed at eleven, never at four or five.** Open-first with
everything struck through after it works at five rows because you rarely see both
halves at once. At eleven you always do, and a list two-thirds crossed out reads
as *finished* when most of it is not — the one misreading a tile that is entirely
a tally cannot afford. So large shows **at most three** done rows and counts the
rest as `+3 done` under the column.

Capped rather than dropped, and that is the whole argument: the struck-through
rows are the only evidence on the tile that it is showing a list somebody is
working through, so a face that hid them would look identical whether it was live
or three days stale. `4 OF 12` in the header says what is left; `+3 done` says
what is behind you and is not on the tile. `doneRowsOnLarge` in
`RidikRowsView.swift` and `DONE_ROWS_ON_LARGE` in `RidikRowsFace.kt` are the same
number for the same reason the row counts match — the same list must not be a
different length on the phone next to yours.

### 3.6 The mic — the one control in the family

Every tap above opens a screen you **read**. This is the one that starts a
sentence, and it is why these tiles are worth their own process at all: the most
repeated line in five-star reviews of everything in this category is capture at
the instant the thought exists, and it is always named at the *entry point*, not
at the app.

A `mic.fill` glyph in `accent`, at the trailing edge of the header, after the
count. Not a cell: §1 gives the family one primitive and says what may fill it,
so a sixth thing wearing that shape would read as data. Chrome in the eyebrow's
own colour reads as a control, which is what it is.

Tap → `ridik:///?speak=1` — home, with a flag on it. Listening is not a place;
the flag is consumed the instant it is read and every guard that makes it fire
exactly once lives in `src/features/voice/speakIntent.ts`.

**Medium and large only, on both platforms.** Not for want of room — a small
tile has 18pt to spare. A `.systemSmall` widget gets exactly one tap target and
it is `widgetURL`, so a `Link` there is inert: the same glyph would open the
reading screen on iOS and the microphone on Android, which is the "two different
products" failure with no way to see it in a screenshot. `SpeakAffordance` in
`RidikElements.swift` and `header()` in `plugins/withRidikAndroidWidget.js` are
the two halves of that rule and both say no.

Not on the notice pane either. "Nothing published yet." and "Ridik was updated."
are the two states where the tile has no header, on both platforms.

---

### 3.7 Rings — medium only

Adopted from the `clay` direction by request, and the only face that draws a
proportion — see §1 for the narrowing that permits it, which is a narrowing and
not a repeal.

One ring per habit: a stroked arc from twelve o'clock clockwise, the share of the
payload's 35-day history that was kept, with the percentage inside the ring
rather than under it. **Six rings, in two rows of three, each with its habit's
name beside it rather than underneath.** 42dp across, 4.5 of stroke.

One row of four across the top of a medium tile left two thirds of it as ground —
the face that is entirely a tally, drawn as a band over a field of nothing. Two
rows of three fill the tile *and* show every habit the payload carries, which is
the thing this face exists to do and the reason it refuses a size that would hide
some of them.

**The name is beside the ring because two rows of it do not otherwise fit, and
never did.** A 56dp ring with four of gap and an eleven-point name under it is a
73dp row; two of those plus the header asked for about 189 of the 130-odd a
medium tile's content box actually has. Neither WidgetKit nor a launcher reports
that — both clip in silence — so the face shipped with its header cut off the top
edge and the second row's names cut off the bottom. Height is the scarce axis
here and width is the abundant one: three columns of a 312dp box is 97 each, and
a name reads perfectly well in the 49 the ring does not want. Sideways, the row
costs 42 instead of 73 and all six habits still show.

**No small, and no large.** Two rings is not a set: it reports on a third of
somebody's habits and hides the rest without saying so, which is the one thing a
face that is entirely a tally must not do. And there is no seventh habit for a
large tile to draw, so the height would buy ground — what §2 rule 1 forbids.
Android floors every tile of it to the medium layout rather than asking for a
file that does not exist; an unresolved layout id draws nothing at all.

Order is the payload's order and is never sorted by how well each habit is going.
That is the same rule the rails follow, for the same reason: re-sorting would
reshuffle the board every time anything is logged, and a ring and a rail must
describe the same habit in the same position.

The number is floored and `100%` is reserved for a record with nothing missed —
34 of 35 says 97, because a habit with a missed day claiming a full score is the
one number on this face that would be a lie. `RidikRings` in Swift and
`RidikRings.kt` hold the identical arithmetic.

**The picker needs its own arc.** The live tile is filled by
`setImageViewBitmap`, and nothing of ours runs in the widget gallery — so the
`ImageView` there had no drawable and the face rendered as an eyebrow over an
empty tile, which is the one place a widget is judged before it is placed. The
preview draws a **vector** instead, built from the same rate arithmetic. A vector
has no stroke, so the arc is a filled annulus sector.

**Android rasters the arc; iOS trims a circle.** RemoteViews cannot draw an arc,
so the Kotlin generates a bitmap — and that bitmap is a **white alpha mask**,
tinted by `android:tint` in the layout. A colour computed in the provider is
computed against the *app's* configuration rather than the launcher's, which is
the near-black-on-near-black bug in §5; a tint is a colour *reference* the
launcher resolves in its own process. It is the same trick the mic glyph uses.

Tap → `ridik:///habits`.

### 3.8 Now / Next / Later — medium, large

The one face that **answers** instead of drawing. Every other tile is an
instrument: it draws a quantity and lets you read it. None of them answers the
plainest question anyone asks a home screen, which is *what am I supposed to be
doing?* Three slots do, in three words.

The primitive still appears — one 6pt bar per slot — so the tile belongs to the
family rather than being a card of text on a matching background. It is
deliberately not a *strip*: a strip would re-answer "how is my day shaped", which
is §3.1's question and §3.1's face.

**Everything is classified against the reading process's own clock.** Which row
is happening now changes every minute while nothing is republished, so none of it
can come from the payload. `agenda` is "what is left of today"; this asks the
clock which of those rows the moment is inside. A face that let the publisher
decide would be wrong for up to half an hour at a time and look entirely
plausible doing it.

`NOW` stays empty when nothing is running rather than borrowing the next thing.
"Now: Robotics lab" when Robotics lab starts in two hours is the one lie this
face is in a position to tell, and the empty copy exists so it does not have to.

**Both sizes draw the day element underneath**, and §1.1 allows exactly one hot
object — so the slots step down to mid / low / cold and the element keeps the
ember, the same trade §3.2 makes between the strip and the plate.

**Large adds the rest of today between the slots and the element**, under an
`AFTER THAT` eyebrow, capped at six rows. It had not: the face was the medium
layout with the same 40pt element under it and a `Spacer` in between, and on a
321pt tile that spacer stretched to 182 — more than half the face, empty. It read
as a tile that had failed to draw rather than as a quiet day, which is the
impression §2 rule 1 exists to prevent. The rows start past the two *future*
rows the slots already spoke for, so nothing is ever printed twice; whatever is
running holds `NOW` without coming out of that queue. When there is nothing
after them the face says so in one line rather than leaving the space blank —
air with no explanation under it is indistinguishable from a rendering fault.

Medium used to stop at the three slots and give `hot` to NOW, which left two
thirds of the tile as ground under three words. The strip is the one thing that
can fill it while still saying something, and it is the same element §3.1 draws
from the same payload — so this face and a Today tile beside it agree about the
day.

**No small.** Three columns in 131pt is 40pt each and truncates every title (§2
rule 2). A one-slot small face would be §3.1's readout with a different word over
it.

Tap → `ridik:///today`.

---

### 3.9 People — small, medium

The debt primitive from §3.4, pointed at promises: one cell per outstanding
promise, oldest left, the single oldest hot. No new primitive and no new
arithmetic — which makes it the cheapest face in the family to have added.

It earns a tile because it is the only face whose data **nothing else in the app
surfaces at a glance**. A promise with no due date can never become overdue, so
it never reaches Tasks, never reaches "due today" and never reaches a briefing.
It simply gets older. That is the app's quietest failure mode, and a strip whose
oldest cell is the hot one is the whole fix.

**Not gated on the day, and that is the one departure from §3.4.** Tasks is a
tally of a particular day and a stale payload keeps its shape while losing its
counts. A promise made three weeks ago is exactly as owed this morning as it was
last night, so "Yesterday's plan." over this face would be a claim about the
wrong thing — the same reasoning that keeps the checklist ungated.

The ages are days since the promise was **made**, not days past due. For most of
these rows there is no due date to be past, which is the point.

Tap → `ridik:///people`.

---

### 3.10 Week — small, medium

Seven cells, Monday first, with today ringed, a weekday letter above each and its
date below. **A day is a column here, not a chip** — the cells take the tile's
height, because seven of them in a band across the top with nothing underneath is
the same cheap drawing every other face on this page was making. The only face that answers a question about *tomorrow*: §3.1 draws
the day you are standing in and §3.2 draws a month you have to find the row in,
and neither says "Thursday is the bad one" at a glance.

**The two platforms reach that differently, and have to.** An iOS medium content
box is 312 x 130, so a measured 68pt bar is exactly right and `RidikChainView`
states it. An Android two-row tile is 215dp on a Galaxy S23 and about 240 on a
Pixel — the same face, nearly twice the height — and the same 68 left a dead band
across the bottom third, which in the picker is the whole of what a stranger
judges the widget by. There is no number correct on both, so the Android bar is
a `layout_weight` and takes whatever is left after the letter and the date. It
degrades better at the other end too: squeezed, the bar gives up its own height
and the date survives, where the fixed version clipped off the date row — and
the date row is the half that says *which* week. `widget-geometry.test.ts` pins
each side to its own approach rather than to a shared number.

**The week is its own payload field and never seven characters of the month
plate.** A week straddling the 1st is half in a month the plate has no cells for,
and slicing would draw those days `cold` — which is how this face says *free*, so
the tile would report a clear Monday over a Monday with four things on it.
`buildWeek` publishes the seven days directly, using the same overlap arithmetic
as the plate so the two can never disagree about a day they both draw.

**Staleness is not asked, deliberately.** `todayIndex` is `-1` when the payload
is not this week's, so no cell is ringed and the face stops claiming a today.
That is the honest degradation and it differs from the agenda's: the *shape* of a
week published yesterday is still the shape of this week.

The dates are what stop this being a second habits rail. Seven anonymous cells
say "some days are busier"; an `11` under the hot one says *which* day, which is
the only question a week-shaped tile is asked.

**No large.** §2 rule 1 — extra height buys more cells before it buys air, and
there is no eighth day to buy.

Tap → `ridik:///calendar`.

---

### 3.11 Countdown — small, medium

One number, one title, one place. The only face that is still moving when nothing
is publishing: `Text(_:style: .timer)` on iOS and `Chronometer` with
`setChronometerCountDown(true)` on Android are the one genuinely live element
either platform gives for zero wakeups.

**It counts to the start, not only to the buffer.** §3.1 already carries a live
number and it counts to `leaveAt` and says "leave in" — honest, and silent for
most of a calendar, because most things have no travel buffer. This face counts
to whichever moment comes first and **changes the verb with it**: "leave in"
while there is a buffer to leave for, "starts in" when there is not. Carrying the
wrong verb over the right number is the single lie a live countdown can tell, so
the two travel together and are chosen in one expression.

**Past it, the face stops counting.** A `Chronometer` counts past its base as
readily as down to it, and `Text(_:style:)` does the same — one left running
unattended reads a rising number where a falling one was. Two things stop that:
the timer is only mounted while there is time left on it, and the moment it runs
out is already a redraw (a one-shot `AlarmManager` on Android with its own
request code, a timeline entry on iOS). Past the start the face says *happening
now*, which is a sentence and not a number, because a countdown at zero reads as
a fault rather than as an answer.

**No large.** Three lines and 300pt of ground under them is the air §2 rule 1
exists to forbid.

Tap → `ridik:///today`.

---

### 3.12 Focus — small, medium

The one face with a live clock over something that has a **natural end**. §3.11
counts to a travel buffer, which most things on a calendar do not have; a running
session ends in forty minutes by construction rather than by inference, which is
what makes a countdown over it honest.

**The strip is the session, not the day.** Sixteen cells of the booked block —
`mid` for focus, `low` for a break — so the shape of a pomodoro plan is visible
before any of it has been spent. Spent cells burn down to the same 38% as
everywhere else, the current cell is the tile's one hot object, and a phase
boundary is the same 2pt hairline §3.1 draws. Nothing new is invented, and
sixteen rather than thirty-two because 32 cells of a 25-minute pomodoro is 47
seconds each — below the resolution at which a boundary means anything.

**Nothing running is a state and it is the common one.** The clock is hidden, the
strip is drawn fully cold, and the copy is "No session." / *Say "focus for 40
minutes"*. A timer tile showing a stale `00:00` is worse than a blank one, which
is §4 applied to a face whose whole content is a number.

**Paused stops the clock rather than freezing a number in it.** The payload sends
*no moments at all* while paused — a paused session has no end, because the
minutes left are known and when they will finish is not, and a countdown to a
receding moment is wrong every second it is on screen. The header says PAUSED and
the strip holds its marker where the pause caught it.

This is the face that would most benefit from iOS Live Activities, which
`src/services/focus/liveActivity.ts` is already a capability-detected adapter
for. Same extension, so the marginal cost of both is one target, not two.

Tap → `ridik:///today`.

---

### 3.13 Skyline — medium only · *an alternative Today*

The same 32 cells as §3.1, but **their height is their level**, which turns the
strip into a silhouette of the day instead of a bar of it. A flat strip tells you
*when* you are busy; a skyline tells you *how* busy at a glance, because height
is read pre-attentively where four opacities are not.

Burn-down still marks now: a spent block keeps its height and drops to the same
38% §1.3 gives a cell, so the step survives and the face can still show that it
is stale. Breaks are the same 2pt hairline before a new booking.

**Medium only.** Thirty-two blocks in 131pt is four points each — narrower than
the hairline between two of them, so the silhouette stops being a silhouette and
becomes a texture. The mechanic needs the width.

**It is an alternative Today and never a companion to it**, and the picker's
description says so. It gives a cell a height *as well as* a level, which is a
second encoding of one variable — precisely §8's objection to gradients. Two
tiles disagreeing about what a cell means on one home screen is the failure; the
user choosing one reading over the other is not.

**The graphic fills its tile.** Every ornament on these faces is sized from the
box it is drawn in — the sundial's disc is 13% of its height, the route's line
27% of its own — which for a while meant the box had to be pinned to a fixed
aspect, because a taller one did not draw the same picture larger, it drew a
*different* picture with a blot for a sun. That left a third of a two-row tile as
ground under a small drawing: correct in shape and cheap to look at, which is the
worse failure of the two. The ornaments are clamped against the horizontal
*step* now — the disc, the dots and the puck all are — so the box is free to grow
and the things on it are not.

**Route is the exception, and it is why it has a one-row tile.** A route is a
line, and a line cannot be made taller without becoming a band. On Android it
declares `4 × 1`; WidgetKit has no such family, so on iOS it keeps `systemMedium`
and the line sits above its caption rather than being stretched to meet it.

**Its box is 44, and the slack is split rather than spent.** At 30 the line was
27% of too little — an eight-point hairline — and every one of the 50-odd points
a medium tile had left over went into a *single* gap between the line and its
caption, which reads as a face with something missing out of the middle. The box
is 44 now and the leftover is halved above and below it, so the line sits in the
middle of its tile, which is what it is. The graphic is still a fixed height:
everything on it is sized from its own box, so letting it grow would draw a
different picture rather than a bigger one.

Widening the box is the same trap in the other axis, and only Android has it:
`scaleType="fitXY"` does not preserve aspect, so a raster whose shape differs
from its `ImageView`'s stretches everything in it. That is what made the puck an
egg, twice — once from a shared 300 × 100 viewport, and once from a 4 × 1 tile
whose *preview card* the launcher drew three columns wide. A short widget's span
is derived from `minWidth`, so `minWidth` has to agree with `cells.width`.

Tap → `ridik:///today`.

---

### 3.14 Sundial — medium only · *an alternative Today*

The same 32 cells laid on a curve, with a solid disc riding it at `now`. Cells
behind you **shrink** rather than burn down, because a curve has no baseline to
burn towards. The disc is the tile's one hot object, so §1.1 holds unchanged.

§1 carries the narrowing that permits it, and the short version is that a path
with a position marker is not a ring: nothing on this face encodes a proportion.

The curve is a **quadratic with its control point at the horizontal midpoint**,
which makes `x(t)` linear in `t` exactly — so `t` *is* the fraction of the window
elapsed and no numeric inversion is needed anywhere. `src/features/today/arc.ts`,
`RidikPlots.sundial` and `Sundial.Geometry` in Swift hold the identical
arithmetic, so the app screen and both platforms' tiles put the sun in the same
place.

**Medium only**, for Skyline's reason and one more: the disc is sized from the
arc's own height, so on a small tile it swallows the dots it is meant to be
riding past. Both the disc and the dots are clamped against the *step* as well as
the height for that reason — 32 dots across a medium tile is about 6.5pt each, and a dot
sized purely from the arc overlapped its neighbours into a caterpillar. Nothing
about a dot means anything once it touches the one beside it.

What it gives up is precision: 32 cells on a straight line are individually
countable, 32 dots on a curve are not. Same conclusion as §3.13 and for the same
reason — an alternative Today, never a companion.

Tap → `ridik:///today`.

---

### 3.15 Route — medium only · *an alternative Today*

The day as a line, its bookings as segments, and `now` as a puck. Spent segments
**thin** behind you rather than burning down — a horizontal line has no baseline
either, the same substitution §3.14 makes.

**The line is continuous, and the rounding is on its ends.** Each segment butts
against the next; a hairline of ground is left only where a booking actually
begins. The caps belong to the *rail* and are applied once — a `clipPath` on
Android, a `clipShape` on iOS — never per segment. Rounding each one instead
turned thirty-two segments across a tile into thirty-two beads at ten points wide
by nine tall, which is the whole metaphor gone.

**A track is laid full width before any of it is drawn**, and the paragraph above
is why that had to be said out loud. "Continuous" was a claim about the *clip*,
and it said nothing about what got drawn into it: an empty cell is level 0, which
is 18% of the accent, and a *spent* empty cell is that times 0.55, which is ten.
Ten per cent of an ember, four points tall, is nothing — so the entire morning of
an ordinary day rendered as blank ground and the route began at the puck. The
face read as a slider somebody had dragged, which is the one thing a journey must
not: no road behind you. Burn-down cannot answer it the way §3.13 does, because a
silhouette has a baseline to shrink towards and a line has none. So the road goes
down first at 13%, and the day is drawn on top of it.

It is honest about position and not about duration. A puck wide enough to see is
about twenty-five minutes of a day, so it reads as *where you are* and never as
*how long this takes*; that is the one thing about this face that could be
mistaken for a measurement, so it is written down. Its radius is clamped against
the segment step as well as the height: past a few segments wide it stops being a
marker sitting on a line and becomes a blot over the part of the day it points
at.

**Medium alone.** The face *is* a line, and 32 segments in 131pt is four points
each — narrower than the break between two of them, which is the whole mechanic.
A large tile is the same line with 200pt of ground under it. Android floors any
squeezed tile to the medium layout rather than asking for a file that does not
exist.

Tap → `ridik:///today`.

---

### 3.16 Term — small, medium

One dot per day, today the hot one, and a count under them. The only expressive
face that needed **no amendment at all**: a dot is the cell at its smallest, and
today is the one hot object.

**Burn-down is the one rule that does not transfer, and the face says why.**
§1.3 is a *height* rule — same level, 38% height, bottom-aligned — and a dot has
no height to take 38% of. Shrinking one takes the ink away in both axes at once,
which drew 241 days of history as a faint speckle under 124 solid days still to
come: the past read as *less* present than the future, which is the opposite of
what the face is for. So every dot is full size and only the opacity moves — the
history is the filled mass, today is the hot one, the days ahead are the faint
tail. That is how *one year*, the app this is lifted from, draws it.

It reads **no load**, which is what lets it sit beside §3.14 without the two
arguing about what a cell means — one is a count of days, the other a measure of
them. It is also the only one of the four that composes with anything.

**Small draws the month, medium the year.** There is no *term*, because the app
models no term or semester; naming one the user never entered would be the face
inventing its own data. The two periods a calendar actually has are the two it
draws.

The day is taken from the **payload's** own date, never the device's: a tile
published in another zone must not count a day the user has not had yet.

Tap → `ridik:///calendar`.

---

## 4. Empty states

Every tile is designed empty first. **Draw the graphic in every empty state** —
cold cells, all slots present. The frame is never a bare sentence on a flat
rectangle, and never a row of zeros.

| Widget / state | Headline | Sub |
| --- | --- | --- |
| Today — clear, before 17:00 | `The day is yours.` | `<n>h <n>m unclaimed.` |
| Today — clear, after 17:00 | `Winding down.` | `<n>h <n>m left.` |
| Today — never used | `Nothing in here yet.` | `Hold the mic and say what's on today.` |
| Calendar S — empty month | `August is clear.` | — |
| Calendar M/L — nothing today | `Nothing booked today.` | `<n>h <n>m unclaimed.` |
| Calendar — never used | `No events yet.` | `Say "lunch with Ana at one".` |
| Habits — none tracked | `Six slots, all cold.` | `Say "I ran today" and the first one lights.` |
| Habits — all done | `All six, today.` | `Longest run: <n> days.` |
| Tasks — nothing open | `Clear.` | `Nothing due, nothing late.` |
| Tasks — never used | `No tasks yet.` | `Say "remind me to call the landlord Friday".` |
| List — no lists | `No list yet.` | `Say "add bolts to the hardware list".` |
| List — all ticked | `<NAME>` | `All twelve done.` |
| any — no snapshot | `Nothing published yet.` | `Open Ridik once and today lands here.` |
| any — version mismatch | `Ridik was updated.` | `Open it once to refresh this widget.` |
| day faces — not today | `Yesterday's plan.` | `Open Ridik to bring today's in.` |
| Calendar plate — not this month | `Last month's plate.` | `Open Ridik to bring this one in.` |

Two rules behind that table:

- **"unclaimed" is computed on the device from its own clock**, by counting cold
  cells at or after now — not from `freeMinutes`, which is the whole window and
  would still say "15h" at nine in the evening. Quantise to the quarter hour.
- **`configured` is what separates "you did everything" from "you have never set
  this up".** Without it those two render identically, which is most of the
  reason an untouched install looks broken rather than empty.
- **A stale day face is not a notice.** "Yesterday's plan." goes *under* the
  drawing, with the strip fully burned down, the rails' last column unlit, the
  counts suppressed. The whole-tile notice pane is only for "nothing published"
  and "wrong version" — the two states where there is genuinely nothing to draw.
  Android redraws at most every thirty minutes, so from midnight until the app
  is next opened this is what every tile on the home screen looks like; routing
  it through the notice pane blanks every widget on the home screen every morning.

The gallery preview is where "the widgets look blank" is judged *before one is
ever placed*. Previews ship populated, with the same fake data on both
platforms.

---

## 4b. Choosing the ember

Three options ship: `ember` (default), `kiln`, `rust`. Each carries a full light
and dark `CellRamp` and one more field that is not decoration.

### `platePeak`, and why a darker ember costs something

**No darker ember is possible at any ramp on the sand ground.** This was solved
for, not guessed: Oxide, Kiln, Madder and Rust all fail the family's own rules
at every combination of alphas, and so does the default ember if you move one of
them.

The month plate is the only place in the family where text sits *on* a filled
cell. That pins the ramp from both ends at once — `mid` has to stay light enough
for a near-black numeral, and `hot` has to stay dark enough for linen — and a
darker ember cannot do both. A paler ground does not rescue it (the constraint
is the ember, not the ground), and inverting the numeral on `mid` fails too:
linen on a mid cell is weaker than ink is.

So `platePeak` names the hottest level the plate may use **in light mode**:
`mid` for `ember`, `low` for the darker two. Under those, a busy day and a very
busy day read alike in light and stay distinct in dark, where the constraint
does not exist. It is a real loss and it is the only one on offer — which is why
`ember` is the default rather than merely the first in the list.

### How the choice reaches each surface

| Surface | How |
| --- | --- |
| The app | `ThemeProvider` resolves `cells` / `accent` / `heat` from the stored choice |
| The payload | `ember: EmberName` — the **name**, never colours, so the widget still owns its own palette and resolves light/dark itself |
| iOS | `RidikPalette.of(scheme:ember:)`; one seam, every face already asks the palette |
| Android | a **resource dimension** — see below |

**Android cannot resolve the ember at draw time.** A colour from
`resources.getColor()` is resolved against the *app* process's configuration
while the launcher draws against its own; that mismatch is what made every row
title vanish in dark mode once already. So the ember is baked into resources:
24 heat drawables and 53 layouts, selected by name through the same
`Resources.getIdentifier` path that already picks size and clock variants, with
light and dark still resolved by the launcher.

**`ember` must stay in `digest()`.** Without it the payload is byte-identical
whenever nothing else moved, so picking a new colour would leave every tile on
the old one until the day happened to turn.

## 5. The two identities

Dark is not light inverted. Five things differ, and they are why the two read as
different objects rather than one object under two lamps.

1. **The direction of travel.** Light: heat *darkens* toward a warm ground — ink
   on hot paper, a printed instrument. Dark: heat *brightens* away from a cold
   one — an emitting, powered instrument. Because the ramp is opacity of ember
   over ground, "more" is always "further from the ground" and never has to be
   remembered as darker or lighter.
2. **The hot cell's numeral inverts, for opposite reasons.** Light gets linen
   knocked out of a solid; dark gets the ground showing through emission.
3. **Dark's hot cell carries a 1pt inner rim** (`#FFB57E`, invisible as a shape,
   reads as glow). Light's takes a 1pt *inset of the ground* instead, so the hot
   cell does not touch its neighbours. Emission versus impression.
4. **Dark tiles carry a 1pt border** (`#1FFFD6B8`); light tiles carry none. A
   near-black tile on a dark photo wallpaper dissolves into it. This is a defect
   fix, not a flourish.
5. **Dark is the hero.** Its ramp spans further — every step is about 20%
   larger in CIE L\* — so it is measurably the better instrument. Gallery
   previews and store screenshots are generated dark.

**Scheme is not in the payload, deliberately.** The launcher can be dark while
the app is light. iOS reads `@Environment(\.colorScheme)`; Android resolves
`values-night`. Both answer to the system, which is the only correct answer.

---

## 6. Type

Neither extension can see Bricolage Grotesque or Martian Mono — they are
registered at runtime by `expo-font` inside the app. `.rounded` stands in for
the human face and `.monospaced` for the instrument face, which preserves the
one distinction the pairing exists to make. The app's own rule carries over:
**mono is for times and for tracked eyebrow labels, never for a title.**

| Role | Size / face |
| --- | --- |
| eyebrow | 10pt mono semibold, tracking +1.2, uppercase |
| readout | 26pt (M) / 30pt (S) mono medium |
| row time | 12pt mono |
| row title | 13pt rounded medium |
| ruler / axis / gutter | 9pt mono, `inkSoft` |
| footer | 12pt rounded, `inkSoft` |

Android: give every tracked label an explicit width and `textAlign=center` —
Android does not count `letterSpacing` when measuring, and "TAP TO S…" is how
that shows up. Give tight text containers 2dp of horizontal slack.

---

## 7. Timelines

**iOS** must generate its own moments; there is no periodic update.
`RidikTimelineProvider` merges: now, `leaveAt`, every agenda start, midnight,
and **a 15-minute stride to the end of the day** — without the stride the
element never burns down between events, while Android gets 30-minute
granularity free. Entries are cheap; only `reloadTimelines` spends the budget.

**Android** gets `updatePeriodMillis` at the platform floor of 30 minutes, plus
a push from `RidikWidgets.redrawAll` on every publish. `onAppWidgetOptionsChanged`
must be wired on every provider, or a resize redraws without re-picking the
layout variant.

---

## 7b. The system control — Control Center and Quick Settings

The same mic, one layer further out: **iOS 18 `ControlWidget`** in the existing
extension (`RidikControls.swift`), **Android `TileService`**
(`RidikSpeakTileService.kt`), registered by the same plugin that registers the
every provider. Both open `ridik:///?speak=1`.

**Both platforms or neither — and the rule is about *controls*.** A
quick-capture button on one platform and not the other is the AGENTS.md failure
arriving through the door nobody would spot in a screenshot comparison, so
`speak-intent.test.tsx` asserts them as a pair.

That rule was written here, about this button, and it is stated in those terms
deliberately: it does **not** govern every surface. §7c ships a Lock Screen set
on iOS alone. The difference is what the failure actually is — a capability that
exists on one platform and is *invisible* on the other, so the user of the poorer
one never learns what they are missing and the two products diverge in the dark.
Android has no Lock Screen widget surface at all; the capability is not hidden
there, it is absent, the way widgets themselves were until a year ago. The
nearest Android equivalent is a notification, which is a different product
decision and not a translation of this one.

What makes this cheap is that a control is **not a widget**. It reads no
snapshot, has no size, no layout, no timeline and no update period; it is a
glyph, a word and a URL. Nothing in §1–§6 applies to it, and adding it cost one
file per platform rather than a sixth face.

Three things that are the platforms being awkward rather than decisions:

- **`ControlWidget` is iOS 18 and this extension ships to 16.4.** The bundle
  adds it through `if #available` — `WidgetBundleBuilder` calls
  `buildLimitedAvailability` — so a phone on 17 gets every widget and is
  never told the control exists. Raising the extension's floor two majors to
  ship a button would be the wrong trade.
- **`startActivityAndCollapse` changed shape in API 34.** The `Intent` overload
  throws `UnsupportedOperationException` once the app targets 34, and the
  `PendingIntent` overload does not exist below it. Both branches are
  load-bearing on a build that targets 36 and ships to 26.
- **A locked phone has to be unlocked first.** Launching straight from the lock
  screen leaves the app running behind the keyguard, holding the microphone and
  invisible. `unlockAndRun` is the supported way to ask and is a no-op on a
  phone that is already open.

And one that is: the tile is `STATE_INACTIVE`, never `STATE_ACTIVE`. It is a
button, not a switch — nothing about the app is "on" while it sits there.

`kind`/class names here are as permanent as a widget's: `RidikSpeakControl` and
`ai.dby.ridik.widgets.RidikSpeakTileService`. Renaming either takes the
button off every Lock Screen and out of every Quick Settings panel it is on.

---

## 7c. The Lock Screen — iOS only

Three accessory families in **one** gallery row (`RidikLockWidget`), because the
Lock Screen's picker groups by slot: the user is choosing what goes in the
circular well, and three separate entries offering one family each would look
like three copies of the same thing.

iOS alone, and §7b is amended above to say why that is allowed. `RidikLockView`
carries the same argument in the source.

**Monochrome is a clarifying test, not a palette problem.** The accessory
renderer flattens everything to white at whatever alpha it is given, so the ember
does not reach this file and the four levels become 22 / 45 / 70 / 100%. Either
that is a loss or it is proof the encoding was never about hue — it is the
second, and nothing here needed rethinking to lose it. That is the argument.

| Family | Draws | The rule it is holding to |
| --- | --- | --- |
| `accessoryInline` | `15:00  Materials lab` | The only thing in the family that is **words only** — no graphic is possible. Everything is spent on the answer; an eyebrow and a count would eat the width. Never blank: "Nothing scheduled" is a real answer, an empty line looks like a failure. |
| `accessoryCircular` | The next time, the day in six buckets, the overdue count | **Not a ring.** `Gauge` in `.accessoryCircularCapacity` is right there and is the exact shape §1 bans; the ban does not lapse because the system handed you a circle. Six buckets is as many as 72 points holds while a filled one can still be told from an empty one, and each is the **busiest** cell in its sixth — averaging would report a free afternoon that has one immovable hour in it. |
| `accessoryRectangular` | The eyebrow, the whole 32-cell strip, the next thing | The only family with room for the day, so it draws all of it — same cells, same burn-down, same 2pt break before a new booking. |

The `kind` string is as permanent as any other: renaming `RidikLockWidget` takes
the tile off every Lock Screen it is on.

---

## 8. What is deliberately not here

- **No bitmaps on Android, except where `RemoteViews` cannot draw the shape at
  all.** This used to be unqualified, and the reasoning behind it still stands
  for every face built from cells: quantising heat into four fixed levels means
  each one is a `View` with a `@drawable/` background the launcher resolves in
  its own process, so there is no night-mode seam and no Binder pressure.

  Five faces cannot be built that way and are rastered — Rings (§3.7), Skyline
  (§3.13), Sundial (§3.14), Route (§3.15) and Term (§3.16). `RemoteViews` cannot
  set a view's width or height before API 31 and this app ships to 26, cannot
  draw a curve at any level, and cannot hold 365 views inside one Binder
  transaction. So the choice was those five or nothing, and the seam is closed
  rather than avoided: **every bitmap here is a white alpha mask and never a
  colour**, tinted by `android:tint` in the layout, which is a colour *reference*
  the launcher resolves against its own light/dark exactly as it does a cell.
  `RidikPlots.kt` and `RidikRings.kt` are the two files allowed to raster, and
  neither of them may call `resources.getColor`.

  What that costs is real and is why these are the only five: one tint is one
  hue, so the four levels become four *opacities* rather than four inks. On a
  face built from cells that would be a loss, because a `mid` cell has to mean
  the same thing on every tile. On these five it is not, because on all five the
  encoding is a position, a height or a share — never the hue.
- **No gradients.** Heat is quantised into four detents. A continuous ramp
  encodes one variable with no tick marks, so "is that two things at three or
  four" becomes unanswerable — and a warm continuous glow is the current
  machine-made-design cliché.
- **No `scheme` field**, no elastic time window, no inferred waking hours (the
  same day would rescale every time a meeting was added), and no history
  reconstructed from a task's current due date (snoozing would silently rewrite
  the past).
