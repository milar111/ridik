# Ridik widgets — the contract

Two platforms draw the same six faces from one published payload. Nothing is
shared between them at build time: an Xcode extension links neither the app nor
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
| cold | `0` | `#F7CFB8` | `#3C190D` | nothing here |
| low | `1` | `#E9A185` | `#772C19` | a little |
| mid | `2` | `#D86B4A` | `#BB4328` | claimed / done |
| hot | `3` | `#C7360F` | `#FF5A36` | **the one urgent thing** |

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

### 3.3 Habits — small, medium, large

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

- **Window: 7 / 21 / 35 days.** Take the *last* N characters of
  `habits.rows[].history`, which is 35 long and ends on `day.date`.
- Levels are **binary**: `'0'` → cold, `'1'` → mid, **and the last cell, if
  `'1'`, is hot**. If today is not done there is no hot cell on the tile, and
  that absence is the message.
- **Cells are vertical bars, not squares.** Width is the constrained axis and
  height is free, so buy the readable dimension with the one you have.
- Names live in a **left gutter**, never above the rail. The cross-habit read —
  "everything dies on a Sunday" — is a vertical read down aligned columns, and a
  name line between rails destroys it.
- Streak in the gutter only when > 1 (`12d`). Large also shows `best 31`.
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

### 3.5 List — small, medium

The quiet one. **No cells, by decision** — a checklist has no time axis and
inventing one would be decoration. One tile without a graphic is what makes the
other five read as chosen rather than as a house style applied everywhere.

Header is the list name and `4 OF 12`. Rows are `○` / `✓` and the text, open
first, done struck through in `inkSoft`. The marks are cold-filled 7pt cells
with a 1pt ground inset — the family's primitive at its quietest.

Tap → `ridik:///notes?pane=lists&list=<urlencoded name>`.

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
  it through the notice pane blanks five widgets every morning.

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
five providers. Both open `ridik:///?speak=1`.

**Both platforms or neither.** A quick-capture button on one and not the other
is the AGENTS.md failure arriving through the door nobody would spot in a
screenshot comparison — so `speak-intent.test.tsx` asserts them as a pair.

What makes this cheap is that a control is **not a widget**. It reads no
snapshot, has no size, no layout, no timeline and no update period; it is a
glyph, a word and a URL. Nothing in §1–§6 applies to it, and adding it cost one
file per platform rather than a sixth face.

Three things that are the platforms being awkward rather than decisions:

- **`ControlWidget` is iOS 18 and this extension ships to 16.4.** The bundle
  adds it through `if #available` — `WidgetBundleBuilder` calls
  `buildLimitedAvailability` — so a phone on 17 gets the five widgets and is
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
`ai.raisen.ridik.widgets.RidikSpeakTileService`. Renaming either takes the
button off every Lock Screen and out of every Quick Settings panel it is on.

---

## 8. What is deliberately not here

- **No bitmaps on Android.** Quantising heat into four fixed levels is what
  removes the need: every cell is a `View` with a drawable background. A
  `Canvas` bitmap would bring the ~1MB Binder ceiling and a night-mode seam —
  the bitmap resolves the *app* process's configuration while the layout's
  `@color/` references resolve the *launcher's*, so a launcher-side dark flip
  would leave a light bitmap on a dark ground for up to thirty minutes.
- **No gradients.** Heat is quantised into four detents. A continuous ramp
  encodes one variable with no tick marks, so "is that two things at three or
  four" becomes unanswerable — and a warm continuous glow is the current
  machine-made-design cliché.
- **No `scheme` field**, no elastic time window, no inferred waking hours (the
  same day would rescale every time a meeting was added), and no history
  reconstructed from a task's current due date (snoozing would silently rewrite
  the past).
