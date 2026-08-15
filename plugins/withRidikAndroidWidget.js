/**
 * The Android widget family's manifest entries and resources.
 *
 * The Kotlin lives in `modules/ridik-widgets/`, which is ordinary source and
 * needs no help surviving anything. Resources are the part that would not: they
 * have to land in the *app* module, and `android/` is regenerated from the Expo
 * template on every `prebuild --clean`. So they are written here instead of
 * committed, and the two halves meet by name — the Kotlin resolves every id
 * below through `Resources.getIdentifier`, because an Android library cannot see
 * the app's `R`.
 *
 * Rename anything here and the widget goes blank rather than failing to build.
 * The names are listed once, in `IDS`, and `RidikCells.kt` → `WidgetIds` is the
 * other end of that list. Keep the two adjacent and keep them in step.
 *
 * ## Why the layouts are generated rather than written
 *
 * RemoteViews cannot loop, cannot set a width, a height or a column count at
 * runtime, and cannot draw a custom view. So a face with 32 half-hour cells is
 * 32 hand-written cells, five sizes of it are five files, and a habit board is
 * 210 of them. Writing that by hand is how the id lists drift apart. Here the
 * geometry is a number and the file is a fold over it.
 *
 * ## Why every cell is an ImageView and not a View
 *
 * `RemoteViews` inflates through a `LayoutInflater.Filter` that only admits
 * classes annotated `@RemoteView`, and plain `android.view.View` is not one of
 * them — a layout containing one throws `InflateException` inside the launcher,
 * where the only symptom is "Problem loading widget". `ImageView` is on the
 * list, costs the same with no `src`, and takes the same
 * `setBackgroundResource`. Nothing here ever sets an image on one.
 */
const fs = require('node:fs');
const path = require('node:path');

const {
  withAndroidManifest,
  withDangerousMod,
  withGradleProperties,
} = require('expo/config-plugins');

const GENERATED = 'Written by plugins/withRidikAndroidWidget.js — edit that, not this.';

// ------------------------------------------------------------------- the ids
/**
 * Every id the Kotlin looks up. The mirror of this list is `WidgetIds` in
 * `modules/ridik-widgets/android/.../RidikCells.kt`.
 *
 * One vocabulary across all five faces rather than one per widget: a row is a
 * row whichever list it came from, and a heat cell is a heat cell whether it is
 * half an hour, a day or an overdue task. Ids are per-layout on Android, so the
 * same name means the same role in every file and the Kotlin needs one resolver.
 */
const IDS = {
  body: 'ridik_body',
  notice: 'ridik_notice',
  noticeTitle: 'ridik_notice_title',
  noticeBody: 'ridik_notice_body',
  eyebrow: 'ridik_eyebrow',
  count: 'ridik_count',
  headline: 'ridik_headline',
  sub: 'ridik_sub',
  allDay: 'ridik_allday',
  next: 'ridik_next',
  readout: 'ridik_readout',
  nextTitle: 'ridik_next_title',
  nextSub: 'ridik_next_sub',
  timer: 'ridik_timer',
  dayArea: 'ridik_day_area',
  plateArea: 'ridik_plate_area',
  railArea: 'ridik_rail_area',
  debtArea: 'ridik_debt_area',
  rowArea: 'ridik_rows',
  footLeft: 'ridik_foot_left',
  footRight: 'ridik_foot_right',
  cell: (i) => `ridik_cell_${i}`,
  cellFull: (i) => `ridik_cell_${i}_full`,
  cellSpent: (i) => `ridik_cell_${i}_spent`,
  axis: (i) => `ridik_axis_${i}`,
  plateWeek: (w) => `ridik_plate_week_${w}`,
  plate: (i) => `ridik_plate_${i}`,
  rail: (r) => `ridik_rail_${r}`,
  railCell: (r, c) => `ridik_rail_${r}_${c}`,
  habitName: (r) => `ridik_habit_name_${r}`,
  habitStreak: (r) => `ridik_habit_streak_${r}`,
  habitBest: (r) => `ridik_habit_best_${r}`,
  wday: (c) => `ridik_wday_${c}`,
  debt: (i) => `ridik_debt_${i}`,
  row: (i) => `ridik_row_${i}`,
  rowLead: (i) => `ridik_row_lead_${i}`,
  rowText: (i) => `ridik_row_text_${i}`,
  /**
   * The same row text, pre-coloured for the done/spent state.
   *
   * Two views rather than one whose colour is set at draw time: a colour
   * resolved in the app's process is resolved against *its* night mode, while
   * the launcher draws the tile against its own. With the app last run in light
   * and the system flipped to dark, every runtime-coloured string was written
   * near-black onto a near-black tile — the ember and the trailing text stayed
   * right, because those come from these `@color/` references, and only the
   * titles vanished. `setColorStateList` fixes it in a line and is API 31; this
   * ships to 26.
   */
  rowSoft: (i) => `ridik_row_soft_${i}`,
  rowTrail: (i) => `ridik_row_trail_${i}`,
  tick: (i) => `ridik_tick_${i}`,
};

// --------------------------------------------------------------- the embers
/**
 * The three embers the user can choose between, and the mirror of `embers` in
 * `src/ui/theme.ts`. Copied rather than imported for the same reason the ramp
 * always was: this file writes XML, and an Android resource cannot import
 * TypeScript. `src/ui/__tests__/widget-tokens.test.ts` is what holds the two
 * together.
 *
 * **Why the ember cannot be a colour computed at draw time.** A colour resolved
 * with `resources.getColor()` is resolved against the *app* process's
 * configuration, while the launcher draws the tile against its own — flip the
 * system to dark with the app last run in light and every runtime-coloured
 * string lands near-black on a near-black tile. So the ember is not a value the
 * Kotlin carries; it is a *name*, and everything it touches exists three times
 * in the resource table with the launcher picking the light or dark half.
 *
 * That is why choosing a colour costs layouts: the ember tints text, text
 * colour lives in the layout XML, and RemoteViews cannot restyle a `TextView`
 * on a build that ships to API 26. Sixteen live layouts become forty-eight,
 * exactly the way five sizes already become sixteen.
 */
const EMBERS = {
  // #C7360F / #FF5A36 at 23 / 46 / 70 / 100 percent.
  ember: {
    light: { cold: '#F2BFA7', low: '#E59679', mid: '#D86B4A', hot: '#C7360F' },
    dark: { cold: '#501F11', low: '#84311C', mid: '#BB4328', hot: '#FF5A36' },
    /**
     * The only accent that is not its own ramp's `hot`.
     *
     * `#FF8253` is the app's `darkColors.accent` and is what has shipped on
     * every dark tile since the family was drawn; the ramp's dark hot is the
     * vivid `#FF5A36`. The default keeps exactly what it has, because the whole
     * point of a colour setting is that the current design is still the one a
     * fresh install draws. See `accentOf` for where the other two come from.
     */
    accent: { light: '#C7360F', dark: '#FF8253' },
    platePeak: 'mid',
  },
  // #A82318 / #F04B3C at 27 / 50 / 74 / 100.
  kiln: {
    light: { cold: '#E8B3A1', low: '#D48676', mid: '#BF5649', hot: '#A82318' },
    dark: { cold: '#551E15', low: '#862C21', mid: '#B93B2E', hot: '#F04B3C' },
    accent: { light: '#A82318', dark: '#F04B3C' },
    platePeak: 'low',
  },
  // #96341A / #DE6038 at the same four.
  rust: {
    light: { cold: '#E3B7A2', low: '#CA8E77', mid: '#B1634A', hot: '#96341A' },
    dark: { cold: '#502414', low: '#7D371F', mid: '#AC4B2B', hot: '#DE6038' },
    accent: { light: '#96341A', dark: '#DE6038' },
    platePeak: 'low',
  },
};

const EMBER_NAMES = Object.keys(EMBERS);

/** What a fresh install draws, and the one the gallery preview is built from. */
const DEFAULT_EMBER = 'ember';

/**
 * Linen on a hot cell, and the ground showing through one. The same pair for all
 * three embers — `onHeat` is the *inversion*, not the ember — so it stays a
 * single shared token rather than three identical ones.
 */
const ON_HEAT = { light: '#FFF7F0', dark: '#1C0E06' };

/**
 * Every ember-tinted word on a tile: the eyebrow, the count beside it, the row
 * leads, the countdown and the RIDIK label on the notice pane.
 *
 * For `kiln` and `rust` this is the ramp's own `hot`, which is the one colour
 * in each palette already proved text-safe against the ground it sits on —
 * light `hot` is what `widget-tokens.test.ts` measures ink against, and dark
 * `hot` is measured against `onHeat`, which *is* the dark ground `#1C0E06`.
 * Both clear 4.5:1 by a rule that is already enforced, so nothing here is a new
 * colour anybody had to invent. `ember` is the exception and keeps the accent it
 * shipped with.
 */
function accentOf(ember, scheme) {
  return EMBERS[ember].accent[scheme];
}

/**
 * The resting wash — 12% of the accent in light, 16% in dark.
 *
 * Nothing in the family draws it today; it is kept per-ember rather than shared
 * because a wash that stayed orange under a rust tile would be wrong the moment
 * anything did.
 */
function washOf(ember, scheme) {
  const alpha = scheme === 'light' ? '1F' : '29';
  return `#${alpha}${accentOf(ember, scheme).slice(1)}`;
}

const accentColour = (ember) => `ridik_widget_${ember}_accent`;
const heatColour = (ember, level) => `ridik_widget_${ember}_heat_${level}`;

/** A cell of the strip, the rails, the debt gauge or the checklist's marks. */
const heatDrawable = (ember, level, today) =>
  `ridik_heat_${ember}_${level}${today ? '_today' : ''}`;

/**
 * A cell of the *month plate*, which is not the same drawable and cannot be.
 *
 * The plate is the one place in the family where text sits on a filled cell, and
 * a darker ember's `mid` is too dark for a near-black numeral on the sand
 * ground — 3.78:1 for kiln, 3.87:1 for rust, against the 4.5 the rest of the
 * family holds. `theme.ts` answers that with `platePeak`: those two cap the
 * plate's load at `low` **in light mode only**, because dark has no such problem
 * (4.98:1 and 4.89:1 there).
 *
 * The cap cannot be applied at draw time. Which scheme is on screen is the
 * *launcher's* answer, not this app's, and a widget that capped in the app's
 * process would flatten a dark plate every time the two disagreed. So it is
 * applied here, in the resource: `drawable/ridik_plate_kiln_2` fills itself from
 * `..._kiln_heat_1`, and `drawable-night/ridik_plate_kiln_2` from
 * `..._kiln_heat_2`. The launcher picks the file, so the launcher applies the
 * cap — which is the only process that knows whether it needs to.
 */
const plateDrawable = (ember, level, today) =>
  `ridik_plate_${ember}_${level}${today ? '_today' : ''}`;

/** The load level a plate cell may actually reach, in the scheme it is drawn in. */
function plateLevel(ember, level, scheme) {
  // `hot` is today, not load, and today carries no numeral on any face that
  // draws one — the cap is about ink, so it stops at the levels ink lands on.
  if (level > 2 || scheme === 'dark' || EMBERS[ember].platePeak === 'mid') return level;
  return Math.min(level, 1);
}

// -------------------------------------------------------------- the geometry
/**
 * Cells per graphic, per size. Every one of these has a twin in Kotlin
 * (`RidikCells.kt` → `Geometry`) because the Kotlin has to know how many slots
 * the layout it just inflated actually has, and asking the resource system is
 * not an option — an id that does not exist resolves to 0 in silence.
 */
const DAY_SLOTS = { small: 8, medium: 32, large: 32 };
const RAIL_DAYS = { small: 7, medium: 21, large: 35 };
const DEBT_SLOTS = { small: 12, medium: 24, large: 24 };
const ROW_SLOTS_BY_SIZE = { small: 4, medium: 6, large: 6 };

/** Rail slots are fixed at six, whatever the size: a board occupies its rectangle. */
const RAIL_SLOTS = 6;

/**
 * How tall a bar is allowed to get.
 *
 * The rails divide the tile's height between them, which is what makes the
 * board fill its rectangle — the first attempt at fixing the stretch pinned
 * them instead, and a tall tile became a small board with three quarters of it
 * empty, which looks worse than a stretched one.
 *
 * So the row fills and the *bar inside it* is capped. The remainder shows as
 * even spacing between rails rather than as a void at the bottom, which is what
 * "extra space buys air" is supposed to mean.
 */
const RAIL_HEIGHT = { small: 16, medium: 15, large: 14 };

/** Six weeks of seven, because a 31-day month starting on a Sunday needs all six. */
const PLATE_CELLS = 42;

/**
 * A plate cell's height, and the ground between two of them.
 *
 * The same rule the rails learned: the *week row* fills, and the cell inside it
 * is capped. Weighted rows with `match_parent` cells gave a tall tile 45dp
 * squares — the plate stops being a calendar and becomes a bar chart of
 * nothing — while a fixed row height overflows the shortest tile Android will
 * call large. Filling and capping is the only pair that survives both ends.
 *
 * 25 and 3 on large are §3.2's own numbers, and the ones iOS draws.
 */
const PLATE_CELL = { small: 16, medium: 16, large: 25 };
const PLATE_GAP = { small: 2, medium: 2, large: 3 };

/**
 * How hard the plate pulls against the spacer under it, on the large face.
 *
 * The plate is the only thing on that tile that can *use* height — up to its
 * cell cap and not a dp further. Sharing the leftover evenly with a spacer gave
 * it 16dp rows on a tile with room for its proper 25, so the calendar was
 * drawn small next to a third of a tile of empty ground. Three to one fills the
 * cap first; past it the plate stops asking and the spacer keeps the rest.
 */
const PLATE_WEIGHT = 3;

/**
 * The debt strip: a cell's width, and how tall the strip is.
 *
 * The cells are a *fixed* width with the slack collected after them, not a
 * weighted row — the strip is a gauge of 12 or 24 detents, and a gauge whose
 * detents get fatter as the tile gets wider is the "stretched way too much"
 * complaint in its purest form. iOS has always drawn it this way (8/10 wide,
 * 16/18 tall); this is Android catching up.
 *
 * On a medium tile narrower than about 310dp the 24th cell falls off the right
 * edge. That is the correct thing to lose: the strip is oldest-first, so the
 * tail is cold, and the true count is printed in the footer either way.
 */
const DEBT = {
  small: { cell: 8, height: 16 },
  medium: { cell: 10, height: 18 },
  large: { cell: 10, height: 18 },
};

/** Must equal `ROW_CAP` in `snapshot.ts` and `ROW_SLOTS` in `RidikRowsFace.kt`. */
const ROW_SLOTS = 6;

/**
 * The element's cell height, and the 38% of it a spent cell burns down to.
 *
 * A pair rather than a ratio because RemoteViews cannot set a height: the short
 * view is written into the XML at its final size, and the only way it can be
 * 38% of the tall one is for both numbers to be decided here.
 */
const ELEMENT = {
  small: { height: 34, spent: 13 },
  medium: { height: 30, spent: 11 },
  large: { height: 30, spent: 11 },
};

/**
 * The lead column's width, which is the one thing a 12-hour device changes.
 *
 * "3:15 PM" needs half again the room of "15:15", and RemoteViews cannot set a
 * width at runtime — so each is its own layout, picked in `RidikRowsFace`
 * against `DateFormat.is24HourFormat`. A ragged left edge down five rows reads
 * as a rendering fault, which is why this is not just `wrap_content`.
 *
 * `narrow` is the small tile's pair. Tasks draws two rows there now, as iOS
 * does, and a 46dp lead beside a 13sp title on a 176dp tile leaves the title
 * about nine characters — the numbers are iOS's own (`ridikLeadWidth`).
 */
const LEAD = { wide: 46, ampm: 62, narrow: 38, narrowAmpm: 54 };

/** The habit gutter: the name, the streak, and on large the personal best. */
/**
 * Wide enough for the word, always.
 *
 * A name that ellipsises to "Readi…" is worse than no name: the rail is
 * identified by it, and half of it identifies nothing. So the gutter is sized
 * to hold a real habit name at 11sp — about 64dp — and the *day window* gives
 * way instead, narrowing to seven days on a tile too narrow to hold both. The
 * one thing that never gives way is the text.
 *
 * `best` is the first column dropped, then `streak`: a streak is a number you
 * can live without, a name is not.
 */
const GUTTER = {
  small: { name: 72, streak: 0, best: 0 },
  medium: { name: 68, streak: 26, best: 0 },
  large: { name: 64, streak: 24, best: 30 },
};

/**
 * The gutter never takes more than this share of the tile.
 *
 * An absolute width is right in the middle of a size bucket and wrong at both
 * ends: 84dp of name on a 140dp tile leaves seven bars four and a half dp each,
 * which is the same hairline failure the wide gutter was introduced to fix. The
 * layout cannot measure, so the share is applied here, against the narrowest
 * tile each bucket can be resized to.
 */
const GUTTER_SHARE = 0.42;
const NARROWEST = { small: 140, medium: 260, large: 360 };

/** 07 / 11 / 15 / 19 / 23 by default; overwritten at draw time from `day.startMinute`. */
const AXIS_LABELS = ['07', '11', '15', '19', '23'];

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

// ---------------------------------------------------------------- the widgets
/**
 * The five faces, each of which is one receiver, one provider XML, one preview
 * and its own set of size variants.
 *
 * `kind` is load-bearing and is **not** a display name: Android identifies a
 * placed widget by its provider class and the resources named from it, so
 * `agenda` stays `agenda` even though the widget is now called Calendar.
 * Renaming either orphans every tile already on a home screen.
 *
 * `clocked` lists the sizes that draw a time in a row lead, and therefore need
 * a second layout with a wider lead for a 12-hour device. It is per *size* and
 * not per widget: Calendar small is the plate alone and has no rows at all,
 * while Tasks small has had two of them since it stopped being the one face
 * that drew none.
 */
const WIDGETS = [
  {
    kind: 'today',
    provider: 'ai.raisen.ridik.widgets.RidikWidgetProvider',
    // The Today widget predates the others and keeps its original resource
    // names, for the same reason its class name is not `RidikTodayProvider`.
    info: 'ridik_widget_info',
    label: 'ridik_widget_label',
    description: 'ridik_widget_description',
    title: 'Ridik — Today',
    blurb: 'Your day as a strip of heat, with the next thing on it.',
    layout: 'ridik_today',
    sizes: ['small', 'medium'],
    // The picker renders the preview at the target size, so it is built from the
    // face that shows the most of what the widget is for.
    previewSize: 'medium',
    clocked: [],
    cells: { width: 4, height: 2 },
  },
  {
    kind: 'agenda',
    provider: 'ai.raisen.ridik.widgets.RidikAgendaWidgetProvider',
    info: 'ridik_rows_agenda_info',
    label: 'ridik_rows_agenda_label',
    description: 'ridik_rows_agenda_description',
    title: 'Ridik — Calendar',
    blurb: 'The shape of the month, and what is still to come today.',
    layout: 'ridik_cal',
    sizes: ['small', 'medium', 'large'],
    previewSize: 'large',
    clocked: ['medium', 'large'],
    cells: { width: 4, height: 3 },
  },
  {
    kind: 'habits',
    provider: 'ai.raisen.ridik.widgets.RidikHabitsWidgetProvider',
    info: 'ridik_rows_habits_info',
    label: 'ridik_rows_habits_label',
    description: 'ridik_rows_habits_description',
    title: 'Ridik — Habits',
    blurb: 'Six rails, five weeks, and whether today is lit.',
    layout: 'ridik_habits',
    sizes: ['small', 'medium', 'large'],
    previewSize: 'medium',
    clocked: [],
    cells: { width: 4, height: 3 },
  },
  {
    kind: 'tasks',
    provider: 'ai.raisen.ridik.widgets.RidikTasksWidgetProvider',
    info: 'ridik_rows_tasks_info',
    label: 'ridik_rows_tasks_label',
    description: 'ridik_rows_tasks_description',
    title: 'Ridik — Tasks',
    blurb: 'How far behind you are, oldest first.',
    layout: 'ridik_tasks',
    sizes: ['small', 'medium'],
    previewSize: 'medium',
    clocked: ['small', 'medium'],
    cells: { width: 4, height: 2 },
  },
  {
    kind: 'list',
    provider: 'ai.raisen.ridik.widgets.RidikListWidgetProvider',
    info: 'ridik_rows_list_info',
    label: 'ridik_rows_list_label',
    description: 'ridik_rows_list_description',
    title: 'Ridik — List',
    blurb: 'The checklist you still have something open on.',
    layout: 'ridik_list',
    sizes: ['small', 'medium'],
    previewSize: 'medium',
    clocked: [],
    cells: { width: 3, height: 3 },
  },
];

// ----------------------------------------------------------------- the sample
/**
 * What the widget picker shows.
 *
 * The picker cannot run any of our code, so the only way to show it a plausible
 * widget is to bake one into a second layout — and "the widgets look blank" is
 * judged there, before a tile is ever placed.
 *
 * Every number and every string here is `WidgetSnapshot.sample` in
 * `RidikSnapshot.swift`, rendered by hand: §4 requires both platforms to ship
 * the *same* fake day, and the two had drifted into different ones — four
 * habits done against two, a list of five against a list of twelve, three debt
 * cells against two. Two pickers showing two products is worse than either.
 *
 * What cannot be copied is the parts iOS derives from `Date()`: the strip, the
 * plate and the clock times are a fixed afternoon here, because a baked layout
 * has no clock.
 *
 * The real layouts inflate showing the notice instead, which is the honest state
 * for a widget nobody has published to yet.
 */
const SAMPLE = {
  // 14 spent, 6 cold, 4 claimed, the next thing, then a clear evening.
  day: {
    load: '00220000002200' + '000000' + '2222' + '3' + '0000000',
    breaks: '00100000001000' + '000000' + '1000' + '1' + '0000000',
    spentThrough: 13,
  },
  today: {
    eyebrow: 'TODAY  THU 13',
    count: '2 LATE',
    readout: '15:00',
    title: 'Materials lab',
    sub: 'leave in 34 min · Workshop 2',
  },
  cal: {
    // The month is the eyebrow and the day is the number beside it — §3.2, and
    // the same header iOS draws. No count: `agenda` is capped at six by the
    // publisher, so "6 LEFT" would be a claim the payload cannot support.
    eyebrow: 'AUGUST',
    count: 'THU 13',
    // iOS's sample carries one, and it is worth previewing: it is the line
    // that costs the tile a row, so a picker without it advertises a face the
    // widget will not always draw.
    allDay: 'Term starts',
    rows: [
      { lead: '15:00', text: 'Materials lab', trail: 'Workshop 2' },
      { lead: '17:30', text: 'Call with Mira', trail: null },
      { lead: '19:00', text: 'Studio clean-up', trail: 'Unit 4' },
    ],
    // Three rows exist; two are drawn, because the all-day line above them
    // costs one — the same arithmetic `RidikRowsFace` does at run time.
    drawnRows: 2,
  },
  habits: {
    eyebrow: 'HABITS',
    // Four of six done, and the four are the rails whose last cell is lit.
    count: '4/6',
    // Each is iOS's seven-day pattern repeated to the 21 this preview draws,
    // with the last cell forced to today's answer.
    rails: [
      { name: 'Run', streak: '12d', history: '011111101111110111111' },
      { name: 'Read', streak: '4d', history: '110110111011011101101' },
      { name: 'Water', streak: null, history: '001101100110110011011' },
      { name: 'Stretch', streak: null, history: '001000100100010010000' },
      { name: 'Journal', streak: '2d', history: '110001111000111100011' },
      { name: 'Vitamin', streak: null, history: '000010000001000000100' },
    ],
  },
  tasks: {
    eyebrow: 'TASKS',
    count: '2 LATE',
    // `ages: [9, 2]` and then nothing — 9 days is the oldest overdue and the
    // tile's one hot cell, 2 days is low, and every other slot is a cold
    // detent of the gauge.
    debt: '31',
    footLeft: 'oldest 9d',
    footRight: '12 open',
    rows: [
      { lead: '9d', text: 'Return the drill to Sam', trail: null },
      { lead: '2d', text: 'Email the tutor about the resit', trail: null },
      { lead: '17:00', text: 'Submit the parts form', trail: null },
    ],
    drawnRows: 3,
  },
  list: {
    eyebrow: 'HARDWARE',
    // Four open of twelve, with six delivered: the header does the one thing
    // `total` exists for, which is to be about the list and not about the rows.
    count: '4 OF 12',
    rows: [
      { text: 'M4 bolts ×20', done: false },
      { text: 'Threadlock', done: false },
      { text: 'Sanding discs', done: false },
      { text: 'Cable ties', done: false },
      { text: 'Masking tape', done: true },
      { text: 'Wet-and-dry paper', done: true },
    ],
    // Five of the six fit a medium tile, which is what iOS shows in the picker.
    drawnRows: 5,
  },
  // A plausible August: a quiet start, a busy middle week, today on the 13th.
  month: {
    name: 'AUGUST',
    // 31 days, '0' | '1' | '2'. `3` is today and today only — see §3.2.
    load: '0010200' + '1002110' + '0212001' + '0102200' + '210',
    firstColumn: 4,
    today: 13,
  },
};

// ------------------------------------------------------------- xml fragments

/** `'` ends a string resource unless it is escaped, and `&` is XML on top of that. */
function xml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function indent(depth) {
  return ' '.repeat(depth);
}

/** How many of a sample's rows the face would actually draw. See `SAMPLE`. */
function sampleRows(sample) {
  return sample.drawnRows == null ? sample.rows.length : sample.drawnRows;
}

/** `android:text` only when there is sample copy — the live layouts ship empty. */
function text(depth, value) {
  return value == null ? '' : `\n${indent(depth)}android:text="${xml(value)}"`;
}

function attr(depth, name, value) {
  return value == null ? '' : `\n${indent(depth)}android:${name}="${value}"`;
}

/**
 * A heat cell.
 *
 * `ImageView` rather than `View` — see the note at the top of this file; and a
 * background rather than a `src`, because `setBackgroundResource` is what the
 * Kotlin calls and a cell that is drawn two ways is a cell that will disagree
 * with itself.
 */
function cell(depth, { id, ember, level = 0, width, height, weight, marginEnd, marginStart, gravity, hidden }) {
  const pad = indent(depth + 4);
  return `${indent(depth)}<ImageView
${pad}android:id="@+id/${id}"
${pad}android:layout_width="${width}"
${pad}android:layout_height="${height}"${attr(depth + 4, 'layout_weight', weight)}${attr(
    depth + 4,
    'layout_marginEnd',
    marginEnd,
  )}${attr(depth + 4, 'layout_marginStart', marginStart)}${attr(depth + 4, 'layout_gravity', gravity)}
${pad}android:background="@drawable/${heatDrawable(ember, level, false)}"
${pad}android:importantForAccessibility="no"${attr(depth + 4, 'visibility', hidden ? 'gone' : null)} />`;
}

/**
 * The eyebrow and the one number beside it.
 *
 * Both are tracked, and Android does not count `letterSpacing` when it measures
 * a line — a label sized to its own content gets ellipsised a character early
 * ("2 LAT…"). The eyebrow is weighted rather than `wrap_content` and the count
 * has an explicit width for exactly that reason.
 */
function header(depth, { ember, eyebrow, count } = {}) {
  const pad = indent(depth + 4);
  return `${indent(depth)}<LinearLayout
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:baselineAligned="true"
${pad}android:orientation="horizontal">

${indent(depth + 2)}<TextView
${indent(depth + 6)}android:id="@+id/${IDS.eyebrow}"
${indent(depth + 6)}android:layout_width="0dp"
${indent(depth + 6)}android:layout_height="wrap_content"
${indent(depth + 6)}android:layout_weight="1"
${indent(depth + 6)}android:ellipsize="end"
${indent(depth + 6)}android:fontFamily="monospace"
${indent(depth + 6)}android:letterSpacing="0.12"
${indent(depth + 6)}android:maxLines="1"${text(depth + 6, eyebrow)}
${indent(depth + 6)}android:textAllCaps="true"
${indent(depth + 6)}android:textColor="@color/${accentColour(ember)}"
${indent(depth + 6)}android:textSize="10sp" />

${indent(depth + 2)}<TextView
${indent(depth + 6)}android:id="@+id/${IDS.count}"
${indent(depth + 6)}android:layout_width="70dp"
${indent(depth + 6)}android:layout_height="wrap_content"
${indent(depth + 6)}android:layout_marginStart="4dp"
${indent(depth + 6)}android:fontFamily="monospace"
${indent(depth + 6)}android:gravity="end"
${indent(depth + 6)}android:letterSpacing="0.08"
${indent(depth + 6)}android:maxLines="1"
${indent(depth + 6)}android:paddingEnd="2dp"
${indent(depth + 6)}android:paddingStart="2dp"${text(depth + 6, count)}
${indent(depth + 6)}android:textAllCaps="true"
${indent(depth + 6)}android:textColor="@color/${accentColour(ember)}"
${indent(depth + 6)}android:textSize="10sp"${attr(depth + 6, 'visibility', count ? null : 'gone')} />
${indent(depth)}</LinearLayout>`;
}

/**
 * The empty-state copy, which lives inside the face and not in the notice pane.
 *
 * Every empty state still draws its graphic — cold cells, all slots present —
 * so this is a line under a drawing rather than a sentence on a flat rectangle.
 * Only "nothing published" and "wrong version" take the whole tile.
 */
function copy(depth) {
  const pad = indent(depth + 4);
  return `${indent(depth)}<TextView
${pad}android:id="@+id/${IDS.headline}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginTop="7dp"
${pad}android:ellipsize="end"
${pad}android:maxLines="2"
${pad}android:textColor="@color/ridik_widget_ink"
${pad}android:textSize="14sp"
${pad}android:visibility="gone" />

${indent(depth)}<TextView
${pad}android:id="@+id/${IDS.sub}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginTop="2dp"
${pad}android:ellipsize="end"
${pad}android:maxLines="2"
${pad}android:textColor="@color/ridik_widget_ink_soft"
${pad}android:textSize="11sp"
${pad}android:visibility="gone" />`;
}

/**
 * The day, as a strip of half-hour cells, with its ruler under it.
 *
 * Two views per cell and exactly one of them visible: a spent cell is the same
 * level at 38% height, bottom-aligned, and RemoteViews cannot set a height. The
 * step in the silhouette is the now-marker — there is no playhead line, which is
 * what lets the face survive a thirty-minute update period. A boundary twenty
 * minutes stale looks fine; a labelled rule twenty minutes stale looks broken.
 *
 * The 2dp gap before a cell where a new booking begins is `paddingStart` on the
 * cell rather than a spacer view, because `setViewPadding` is the one geometry
 * call RemoteViews does have — and 31 spacers would have cost more views than
 * the whole rest of the tile.
 */
function element(depth, { ember, size, sample }) {
  const slots = DAY_SLOTS[size];
  const { height, spent: spentHeight } = ELEMENT[size];
  const per = sample ? sample.load.length / slots : 0;

  const cells = [];
  for (let i = 0; i < slots; i++) {
    let level = 0;
    let spent = false;
    let brk = false;
    if (sample) {
      const lo = Math.floor(i * per);
      const hi = Math.floor((i + 1) * per);
      for (let source = lo; source < hi; source++) {
        level = Math.max(level, Number(sample.load[source]));
      }
      spent = hi - 1 <= sample.spentThrough;
      brk = i > 0 && sample.breaks[lo] === '1';
    }
    const pad = indent(depth + 6);
    cells.push(`${indent(depth + 2)}<FrameLayout
${pad}android:id="@+id/${IDS.cell(i)}"
${pad}android:layout_width="0dp"
${pad}android:layout_height="${height}dp"
${pad}android:layout_weight="1"${
      i === slots - 1 ? '' : `\n${pad}android:layout_marginEnd="2dp"`
    }${brk ? `\n${pad}android:paddingStart="2dp"` : ''}>

${cell(depth + 4, {
      id: IDS.cellFull(i),
      ember,
      level,
      width: 'match_parent',
      height: 'match_parent',
      hidden: spent,
    })}

${cell(depth + 4, {
      id: IDS.cellSpent(i),
      ember,
      level,
      width: 'match_parent',
      height: `${spentHeight}dp`,
      gravity: 'bottom',
      hidden: !spent,
    })}
${indent(depth + 2)}</FrameLayout>`);
  }

  return `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:id="@+id/${IDS.dayArea}"
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="wrap_content"
${indent(depth + 4)}android:layout_marginTop="7dp"
${indent(depth + 4)}android:orientation="vertical">

${indent(depth + 2)}<LinearLayout
${indent(depth + 6)}android:layout_width="match_parent"
${indent(depth + 6)}android:layout_height="wrap_content"
${indent(depth + 6)}android:orientation="horizontal">

${cells.join('\n\n')}
${indent(depth + 2)}</LinearLayout>

${axis(depth + 2)}
${indent(depth)}</LinearLayout>`;
}

/**
 * The ruler under the element: five marks at the quarters of the window.
 *
 * The labels are set at draw time from `day.startMinute`, not baked in, because
 * the waking window is a Settings value — a strip that started at 06:00 under a
 * label reading 07 would be wrong by an hour and look perfectly fine.
 */
function axis(depth) {
  const marks = AXIS_LABELS.map((label, index) => {
    const last = index === AXIS_LABELS.length - 1;
    const pad = indent(depth + 6);
    return `${indent(depth + 2)}<TextView
${pad}android:id="@+id/${IDS.axis(index)}"
${pad}android:layout_width="${last ? 'wrap_content' : '0dp'}"
${pad}android:layout_height="wrap_content"${last ? '' : `\n${pad}android:layout_weight="1"`}
${pad}android:fontFamily="monospace"
${pad}android:gravity="${last ? 'end' : 'start'}"
${pad}android:includeFontPadding="false"
${pad}android:maxLines="1"
${pad}android:text="${label}"
${pad}android:textColor="@color/ridik_widget_ink_soft"
${pad}android:textSize="9sp" />`;
  });

  return `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="wrap_content"
${indent(depth + 4)}android:layout_marginTop="3dp"
${indent(depth + 4)}android:orientation="horizontal">

${marks.join('\n\n')}
${indent(depth)}</LinearLayout>`;
}

/**
 * The month, as a plate of one cell per day.
 *
 * Every cell is a `TextView` even at the size that draws no numerals: 10pt
 * digits in a 17dp cell are unreadable at arm's length and the shape of the
 * month is what is being read — but a face that swapped the view *type* between
 * sizes would need the Kotlin to know which one it inflated before it could set
 * a single string, and getting that wrong throws inside the launcher.
 *
 * Out-of-month cells are hidden `INVISIBLE` and never `GONE`: a `GONE` child is
 * dropped from `LinearLayout` weight distribution, so the first and last weeks
 * would get visibly wider columns than the four between them.
 *
 * `todayIsHot` is false wherever the tile also draws an element — §3.2 gives the
 * one hot cell to the element, and today on the plate keeps its ring and its own
 * load level. That ring is only visible at all this way: every ember's accent
 * and its own `heat_3` are the same colour in light mode, so a ring around a hot
 * fill is a ring around nothing.
 *
 * The fills come from `plateDrawable` and not from `heatDrawable`, which is
 * where `platePeak` lives — the darker embers cap the plate's load at `low` in
 * light and keep all four in dark, and only the launcher knows which of the two
 * it is drawing.
 *
 * The week row fills and the cell inside it is capped, which is the rails' rule
 * applied to a grid: weighted rows of `match_parent` cells turned a tall tile's
 * plate into 45dp slabs, and pinning the rows instead overflows the shortest
 * tile Android calls large. Slack shows as ground between the weeks.
 *
 * The letters are written at draw time — see `RidikCells.plate` — because the
 * week does not start on Monday everywhere and "M T W T F S S" is not a
 * calendar in most of the world. What is baked here is the fallback and what
 * the picker shows.
 */
function plate(depth, { ember, size, numerals, sample, todayIsHot = true }) {
  const cellHeight = PLATE_CELL[size];
  const gap = PLATE_GAP[size];

  const heads = WEEKDAYS.map((day, index) => {
    const pad = indent(depth + 6);
    return `${indent(depth + 2)}<TextView
${pad}android:id="@+id/${IDS.wday(index)}"
${pad}android:layout_width="0dp"
${pad}android:layout_height="wrap_content"
${pad}android:layout_weight="1"${index === WEEKDAYS.length - 1 ? '' : `\n${pad}android:layout_marginEnd="${gap}dp"`}
${pad}android:fontFamily="monospace"
${pad}android:gravity="center"
${pad}android:includeFontPadding="false"
${pad}android:maxLines="1"
${pad}android:text="${day}"
${pad}android:textColor="@color/ridik_widget_ink_soft"
${pad}android:textSize="9sp" />`;
  });

  const weeks = [];
  for (let week = 0; week < PLATE_CELLS / 7; week++) {
    const days = [];
    for (let column = 0; column < 7; column++) {
      const index = week * 7 + column;
      let level = 0;
      let day = null;
      let today = false;
      let hidden = false;
      if (sample) {
        const number = index - sample.firstColumn + 1;
        if (number < 1 || number > sample.load.length) {
          hidden = true;
        } else {
          today = number === sample.today;
          level = today && todayIsHot ? 3 : Number(sample.load[number - 1]);
          day = numerals ? String(number) : null;
        }
      }
      const pad = indent(depth + 6);
      days.push(`${indent(depth + 4)}<TextView
${pad}android:id="@+id/${IDS.plate(index)}"
${pad}android:layout_width="0dp"
${pad}android:layout_height="${cellHeight}dp"
${pad}android:layout_weight="1"${column === 6 ? '' : `\n${pad}android:layout_marginEnd="${gap}dp"`}
${pad}android:background="@drawable/${plateDrawable(ember, level, today)}"
${pad}android:fontFamily="monospace"
${pad}android:gravity="center"
${pad}android:includeFontPadding="false"
${pad}android:maxLines="1"${text(depth + 6, day)}
${pad}android:textColor="@color/${
        today && todayIsHot ? 'ridik_widget_on_heat' : 'ridik_widget_ink'
      }"
${pad}android:textSize="${numerals ? '13sp' : '1sp'}"${attr(
        depth + 6,
        'visibility',
        hidden ? 'invisible' : null,
      )} />`);
    }

    weeks.push(`${indent(depth + 2)}<LinearLayout
${indent(depth + 6)}android:id="@+id/${IDS.plateWeek(week)}"
${indent(depth + 6)}android:layout_width="match_parent"
${indent(depth + 6)}android:layout_height="0dp"
${indent(depth + 6)}android:layout_marginTop="${gap}dp"
${indent(depth + 6)}android:layout_weight="1"
${indent(depth + 6)}android:gravity="center_vertical"
${indent(depth + 6)}android:orientation="horizontal">

${days.join('\n\n')}
${indent(depth + 2)}</LinearLayout>`);
  }

  return `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:id="@+id/${IDS.plateArea}"
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="0dp"
${indent(depth + 4)}android:layout_marginTop="5dp"
${indent(depth + 4)}android:layout_weight="${size === 'large' ? PLATE_WEIGHT : 1}"
${indent(depth + 4)}android:orientation="vertical">

${indent(depth + 2)}<LinearLayout
${indent(depth + 6)}android:layout_width="match_parent"
${indent(depth + 6)}android:layout_height="wrap_content"
${indent(depth + 6)}android:orientation="horizontal">

${heads.join('\n\n')}
${indent(depth + 2)}</LinearLayout>

${weeks.join('\n\n')}
${indent(depth)}</LinearLayout>`;
}

/**
 * Six habit rails, a name gutter, and one bar per day.
 *
 * Always all six slots, whether or not a habit exists for them: a board occupies
 * its rectangle at zero habits and the empty slots teach the capacity without a
 * word. The names live in the gutter and never above the rail, because the read
 * this exists for — "everything dies on a Sunday" — is a vertical one down
 * aligned columns, and a name line between rails destroys it.
 *
 * Cells are vertical bars rather than squares. Width is the constrained axis and
 * height is free, so the readable dimension is bought with the one there is.
 */
function rails(depth, { ember, size, sample }) {
  const days = RAIL_DAYS[size];
  const ideal = GUTTER[size];
  // Content width is the tile less the root padding on both sides.
  const room = (NARROWEST[size] - 24) * GUTTER_SHARE;
  const gutter = {
    ...ideal,
    name: Math.max(44, Math.min(ideal.name, Math.round(room - ideal.streak - ideal.best))),
  };
  const wide = gutter.name + gutter.streak + gutter.best;

  const label = (depth2, { id, width, gravity, value, colour, sizeSp }) => {
    const pad = indent(depth2 + 4);
    return `${indent(depth2)}<TextView
${pad}android:id="@+id/${id}"
${pad}android:layout_width="${width}dp"
${pad}android:layout_height="wrap_content"
${pad}android:ellipsize="end"
${pad}android:fontFamily="${sizeSp === 9 ? 'monospace' : 'sans-serif'}"
${pad}android:gravity="${gravity}"
${pad}android:includeFontPadding="false"
${pad}android:maxLines="1"
${pad}android:paddingEnd="4dp"${text(pad.length, value)}
${pad}android:textColor="@color/${colour}"
${pad}android:textSize="${sizeSp}sp" />`;
  };

  const rows = [];
  for (let rail = 0; rail < RAIL_SLOTS; rail++) {
    const row = sample ? sample.rails[rail] : null;
    const bars = [];
    for (let day = 0; day < days; day++) {
      // Binary, and the last cell is the hot one when today is done. If today
      // is not done there is no hot cell on this rail, and that absence is the
      // message the whole face exists to deliver.
      let level = 0;
      if (row) {
        const lit = row.history[day] === '1';
        level = lit ? (day === days - 1 ? 3 : 2) : 0;
      }
      bars.push(
        cell(depth + 4, {
          id: IDS.railCell(rail, day),
          ember,
          level,
          width: '0dp',
          height: `${RAIL_HEIGHT[size]}dp`,
          weight: '1',
          marginEnd: day === days - 1 ? null : '1dp',
        }),
      );
    }

    const pad = indent(depth + 6);
    rows.push(`${indent(depth + 2)}<LinearLayout
${pad}android:id="@+id/${IDS.rail(rail)}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="0dp"
${pad}android:layout_marginTop="2dp"
${pad}android:layout_weight="1"
${pad}android:gravity="center_vertical"
${pad}android:orientation="horizontal">

${label(depth + 4, {
      id: IDS.habitName(rail),
      width: gutter.name,
      gravity: 'start',
      value: row ? row.name : null,
      colour: 'ridik_widget_ink',
      sizeSp: 11,
    })}

${label(depth + 4, {
      id: IDS.habitStreak(rail),
      width: gutter.streak,
      gravity: 'end',
      value: row ? row.streak : null,
      colour: 'ridik_widget_ink_soft',
      sizeSp: 9,
    })}${
      gutter.best === 0
        ? ''
        : `\n\n${label(depth + 4, {
            id: IDS.habitBest(rail),
            width: gutter.best,
            gravity: 'end',
            value: null,
            colour: 'ridik_widget_ink_soft',
            sizeSp: 9,
          })}`
    }

${bars.join('\n\n')}
${indent(depth + 2)}</LinearLayout>`);
  }

  // The weekday ruler is set at draw time, because a window that ends on today
  // rotates its columns every midnight — a static M-to-S header would be right
  // one day in seven. Large has no ruler at all: 35 columns inside a phone
  // widget is about 5dp each, and a letter does not fit in 5dp.
  const ruler = days > 21 ? '' : `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="wrap_content"
${indent(depth + 4)}android:layout_marginTop="6dp"
${indent(depth + 4)}android:orientation="horizontal">

${indent(depth + 2)}<ImageView
${indent(depth + 6)}android:layout_width="${wide}dp"
${indent(depth + 6)}android:layout_height="1dp"
${indent(depth + 6)}android:importantForAccessibility="no" />

${Array.from({ length: days }, (_, day) => {
    const pad = indent(depth + 6);
    return `${indent(depth + 2)}<TextView
${pad}android:id="@+id/${IDS.wday(day)}"
${pad}android:layout_width="0dp"
${pad}android:layout_height="wrap_content"
${pad}android:layout_weight="1"${day === days - 1 ? '' : `\n${pad}android:layout_marginEnd="1dp"`}
${pad}android:fontFamily="monospace"
${pad}android:gravity="center"
${pad}android:includeFontPadding="false"
${pad}android:maxLines="1"${text(depth + 6, sample ? WEEKDAYS[day % 7] : null)}
${pad}android:textColor="@color/ridik_widget_ink_soft"
${pad}android:textSize="8sp" />`;
  }).join('\n\n')}
${indent(depth)}</LinearLayout>

`;

  return `${ruler}${indent(depth)}<LinearLayout
${indent(depth + 4)}android:id="@+id/${IDS.railArea}"
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="0dp"
${indent(depth + 4)}android:layout_marginTop="2dp"
${indent(depth + 4)}android:layout_weight="1"
${indent(depth + 4)}android:orientation="vertical">

${rows.join('\n\n')}

${indent(depth)}</LinearLayout>`;
}

/**
 * One cell per open task, oldest left.
 *
 * The axis is age, not clock time. `due` in the tool contract is a full
 * `YYYY-MM-DDTHH:mm`, so the model invents an hour whenever the user did not say
 * one — plotting that as a position would render fiction as data. How late
 * something is was never guessed.
 *
 * A cell has a size here too. The cells were weighted across the tile, so a
 * widget dragged out to the full width of the phone drew twenty-four fat
 * blocks — the gauge stopped reading as detents and started reading as a
 * stretched bar. They are pinned to iOS's width now and the slack collects in
 * the spacer at the end, which is what "extra space buys air" means on the one
 * axis this face does not grow along.
 */
function debt(depth, { ember, size, sample }) {
  const slots = DEBT_SLOTS[size];
  const { cell: width, height } = DEBT[size];
  const cells = Array.from({ length: slots }, (_, index) =>
    cell(depth + 2, {
      id: IDS.debt(index),
      ember,
      level: sample ? Number(sample.debt[index] || 0) : 0,
      width: `${width}dp`,
      height: 'match_parent',
      marginEnd: index === slots - 1 ? null : '2dp',
    }),
  );

  // `android.widget.Space` is not on the RemoteViews inflate allow-list — a
  // layout with one in it gives "Can't load widget" and nothing else. This is
  // the third time that has cost a build; FrameLayout is allowed.
  const tail = `${indent(depth + 2)}<FrameLayout
${indent(depth + 6)}android:layout_width="0dp"
${indent(depth + 6)}android:layout_height="match_parent"
${indent(depth + 6)}android:layout_weight="1"
${indent(depth + 6)}android:importantForAccessibility="no" />`;

  return `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:id="@+id/${IDS.debtArea}"
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="${height}dp"
${indent(depth + 4)}android:layout_marginTop="7dp"
${indent(depth + 4)}android:orientation="horizontal">

${cells.join('\n\n')}

${tail}
${indent(depth)}</LinearLayout>`;
}

/** "oldest 9d" on the left, the true count on the right — the cells are capped. */
function footer(depth, { sample }) {
  const pad = indent(depth + 6);
  return `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="wrap_content"
${indent(depth + 4)}android:layout_marginTop="4dp"
${indent(depth + 4)}android:baselineAligned="true"
${indent(depth + 4)}android:orientation="horizontal">

${indent(depth + 2)}<TextView
${pad}android:id="@+id/${IDS.footLeft}"
${pad}android:layout_width="0dp"
${pad}android:layout_height="wrap_content"
${pad}android:layout_weight="1"
${pad}android:ellipsize="end"
${pad}android:maxLines="1"${text(pad.length, sample ? sample.footLeft : null)}
${pad}android:textColor="@color/ridik_widget_ink_soft"
${pad}android:textSize="11sp" />

${indent(depth + 2)}<TextView
${pad}android:id="@+id/${IDS.footRight}"
${pad}android:layout_width="wrap_content"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginStart="6dp"
${pad}android:maxLines="1"${text(pad.length, sample ? sample.footRight : null)}
${pad}android:textColor="@color/ridik_widget_ink_soft"
${pad}android:textSize="11sp" />
${indent(depth)}</LinearLayout>`;
}

/**
 * A list of `HH:mm  title` rows with an optional trailing note.
 *
 * The lead is a fixed width rather than `wrap_content` so the titles line up
 * down the list — "9:40" and "11:05" are different widths even in a monospaced
 * face, and a ragged left edge on five rows reads as a rendering fault.
 *
 * A preview fills `sample.drawnRows` of them and leaves the rest `gone`,
 * because the slot count is the layout's capacity and not the face's: iOS caps
 * the Calendar at three and the checklist at five, and a picker that showed six
 * would be advertising a tile the widget never draws.
 */
function rows(depth, { ember, slots, leadWidth, sample, fill = true }) {
  const drawn = [];
  for (let index = 0; index < slots; index++) {
    const row = sample && index < sampleRows(sample) ? sample.rows[index] : null;
    const pad = indent(depth + 6);
    drawn.push(`${indent(depth + 2)}<LinearLayout
${pad}android:id="@+id/${IDS.row(index)}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"${index === 0 ? '' : `\n${pad}android:layout_marginTop="5dp"`}
${pad}android:baselineAligned="true"
${pad}android:orientation="horizontal"${attr(pad.length, 'visibility', row ? null : 'gone')}>

${indent(depth + 4)}<TextView
${indent(depth + 8)}android:id="@+id/${IDS.rowLead(index)}"
${indent(depth + 8)}android:layout_width="${leadWidth}dp"
${indent(depth + 8)}android:layout_height="wrap_content"
${indent(depth + 8)}android:ellipsize="end"
${indent(depth + 8)}android:fontFamily="monospace"
${indent(depth + 8)}android:includeFontPadding="false"
${indent(depth + 8)}android:maxLines="1"${text(depth + 8, row ? row.lead : null)}
${indent(depth + 8)}android:textColor="@color/${accentColour(ember)}"
${indent(depth + 8)}android:textSize="11sp" />

${indent(depth + 4)}<TextView
${indent(depth + 8)}android:id="@+id/${IDS.rowText(index)}"
${indent(depth + 8)}android:layout_width="0dp"
${indent(depth + 8)}android:layout_height="wrap_content"
${indent(depth + 8)}android:layout_marginStart="6dp"
${indent(depth + 8)}android:layout_weight="1"
${indent(depth + 8)}android:ellipsize="end"
${indent(depth + 8)}android:includeFontPadding="false"
${indent(depth + 8)}android:maxLines="1"${text(depth + 8, row ? row.text : null)}
${indent(depth + 8)}android:textColor="@color/ridik_widget_ink"
${indent(depth + 8)}android:textSize="13sp" />

${indent(depth + 4)}<TextView
${indent(depth + 8)}android:id="@+id/${IDS.rowSoft(index)}"
${indent(depth + 8)}android:layout_width="0dp"
${indent(depth + 8)}android:layout_height="wrap_content"
${indent(depth + 8)}android:layout_marginStart="6dp"
${indent(depth + 8)}android:layout_weight="1"
${indent(depth + 8)}android:ellipsize="end"
${indent(depth + 8)}android:includeFontPadding="false"
${indent(depth + 8)}android:maxLines="1"
${indent(depth + 8)}android:textColor="@color/ridik_widget_ink_soft"
${indent(depth + 8)}android:textSize="13sp"
${indent(depth + 8)}android:visibility="gone" />

${indent(depth + 4)}<TextView
${indent(depth + 8)}android:id="@+id/${IDS.rowTrail(index)}"
${indent(depth + 8)}android:layout_width="wrap_content"
${indent(depth + 8)}android:layout_height="wrap_content"
${indent(depth + 8)}android:layout_marginStart="6dp"
${indent(depth + 8)}android:ellipsize="end"
${indent(depth + 8)}android:fontFamily="monospace"
${indent(depth + 8)}android:includeFontPadding="false"
${indent(depth + 8)}android:maxLines="1"${text(depth + 8, row ? row.trail : null)}
${indent(depth + 8)}android:textColor="@color/ridik_widget_ink_soft"
${indent(depth + 8)}android:textSize="9sp"${attr(
      depth + 8,
      'visibility',
      row && row.trail ? null : 'gone',
    )} />
${indent(depth + 2)}</LinearLayout>`);
  }

  return `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:id="@+id/${IDS.rowArea}"
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="${fill ? '0dp' : 'wrap_content'}"
${indent(depth + 4)}android:layout_marginTop="7dp"${fill ? `\n${indent(depth + 4)}android:layout_weight="1"` : ''}
${indent(depth + 4)}android:orientation="vertical">

${drawn.join('\n\n')}
${indent(depth)}</LinearLayout>`;
}

/**
 * The checklist, which is the one face with no cells by decision.
 *
 * A checklist has no time axis and inventing one would be decoration. One tile
 * without a graphic is what makes the other four read as chosen rather than as a
 * house style applied everywhere. The marks are still the family's primitive,
 * at its quietest: a 7dp cell with a 1dp inset of ground.
 */
function tickRows(depth, { ember, slots, sample, fill = true }) {
  const drawn = [];
  for (let index = 0; index < slots; index++) {
    const row = sample && index < sampleRows(sample) ? sample.rows[index] : null;
    const pad = indent(depth + 6);
    drawn.push(`${indent(depth + 2)}<LinearLayout
${pad}android:id="@+id/${IDS.row(index)}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"${index === 0 ? '' : `\n${pad}android:layout_marginTop="6dp"`}
${pad}android:gravity="center_vertical"
${pad}android:orientation="horizontal"${attr(pad.length, 'visibility', row ? null : 'gone')}>

${cell(depth + 4, {
      id: IDS.tick(index),
      ember,
      level: row && row.done ? 2 : 0,
      width: '7dp',
      height: '7dp',
      marginStart: '1dp',
      marginEnd: '8dp',
    })}

${indent(depth + 4)}<TextView
${indent(depth + 8)}android:id="@+id/${IDS.rowText(index)}"
${indent(depth + 8)}android:layout_width="0dp"
${indent(depth + 8)}android:layout_height="wrap_content"
${indent(depth + 8)}android:layout_weight="1"
${indent(depth + 8)}android:ellipsize="end"
${indent(depth + 8)}android:includeFontPadding="false"
${indent(depth + 8)}android:maxLines="1"${text(depth + 8, row ? row.text : null)}
${indent(depth + 8)}android:textColor="@color/ridik_widget_ink"
${indent(depth + 8)}android:textSize="13sp" />

${indent(depth + 4)}<TextView
${indent(depth + 8)}android:id="@+id/${IDS.rowSoft(index)}"
${indent(depth + 8)}android:layout_width="0dp"
${indent(depth + 8)}android:layout_height="wrap_content"
${indent(depth + 8)}android:layout_weight="1"
${indent(depth + 8)}android:ellipsize="end"
${indent(depth + 8)}android:includeFontPadding="false"
${indent(depth + 8)}android:maxLines="1"
${indent(depth + 8)}android:textColor="@color/ridik_widget_ink_soft"
${indent(depth + 8)}android:textSize="13sp"
${indent(depth + 8)}android:visibility="gone" />
${indent(depth + 2)}</LinearLayout>`);
  }

  return `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:id="@+id/${IDS.rowArea}"
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="${fill ? '0dp' : 'wrap_content'}"
${indent(depth + 4)}android:layout_marginTop="8dp"${fill ? `\n${indent(depth + 4)}android:layout_weight="1"` : ''}
${indent(depth + 4)}android:orientation="vertical">

${drawn.join('\n\n')}
${indent(depth)}</LinearLayout>`;
}

/**
 * The next thing, and when to leave for it.
 *
 * The countdown is a `Chronometer` with `setChronometerCountDown(true)` — the
 * only genuinely live element either platform gives for zero wakeups. Its
 * format string carries the location too, so the live line is one view rather
 * than a row that has to be re-measured every second.
 */
function nextUp(depth, { ember, stacked, sample }) {
  const pad = indent(depth + 6);
  // Small stacks the readout over the title; medium sets them on one baseline.
  // The only structural difference is the row that wraps them, so the two views
  // are written once and the wrapper decides where they sit.
  const at = stacked ? depth + 2 : depth + 4;
  const inner = indent(at + 4);
  const readout = `${indent(at)}<TextView
${inner}android:id="@+id/${IDS.readout}"
${inner}android:layout_width="${stacked ? 'match_parent' : 'wrap_content'}"
${inner}android:layout_height="wrap_content"
${inner}android:fontFamily="monospace"
${inner}android:includeFontPadding="false"
${inner}android:maxLines="1"${text(at + 4, sample ? sample.readout : null)}
${inner}android:textColor="@color/ridik_widget_ink"
${inner}android:textSize="${stacked ? '30' : '26'}sp" />`;

  const title = `${indent(at)}<TextView
${inner}android:id="@+id/${IDS.nextTitle}"
${inner}android:layout_width="${stacked ? 'match_parent' : '0dp'}"
${inner}android:layout_height="wrap_content"
${inner}android:layout_margin${stacked ? 'Top="1dp"' : 'Start="8dp"'}${
    stacked ? '' : `\n${inner}android:layout_weight="1"`
  }
${inner}android:ellipsize="end"
${inner}android:includeFontPadding="false"
${inner}android:maxLines="${stacked ? 2 : 1}"${text(at + 4, sample ? sample.title : null)}
${inner}android:textColor="@color/ridik_widget_ink"
${inner}android:textSize="14sp" />`;

  const head = stacked
    ? `${readout}\n\n${title}`
    : `${indent(depth + 2)}<LinearLayout
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:baselineAligned="true"
${pad}android:orientation="horizontal">

${readout}

${title}
${indent(depth + 2)}</LinearLayout>`;

  return `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:id="@+id/${IDS.next}"
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="wrap_content"
${indent(depth + 4)}android:layout_marginTop="8dp"
${indent(depth + 4)}android:orientation="vertical">

${head}

${indent(depth + 2)}<Chronometer
${pad}android:id="@+id/${IDS.timer}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginTop="3dp"
${pad}android:ellipsize="end"
${pad}android:includeFontPadding="false"
${pad}android:maxLines="1"
${pad}android:textColor="@color/${accentColour(ember)}"
${pad}android:textSize="11sp"
${pad}android:visibility="gone" />

${indent(depth + 2)}<TextView
${pad}android:id="@+id/${IDS.nextSub}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginTop="3dp"
${pad}android:ellipsize="end"
${pad}android:maxLines="1"${text(pad.length, sample ? sample.sub : null)}
${pad}android:textColor="@color/${accentColour(ember)}"
${pad}android:textSize="11sp"${attr(pad.length, 'visibility', sample ? null : 'gone')} />
${indent(depth)}</LinearLayout>`;
}

/**
 * Slack: the vertical air a tile larger than its content has left over.
 *
 * A `FrameLayout` and not `android.widget.Space`, which is not on the
 * RemoteViews inflate allow-list — the symptom is "Can't load widget" on the
 * home screen and `Class not allowed to be inflated` in logcat, and nothing at
 * build time. Weighted, so it takes whatever is left and measures zero when
 * nothing is: a face that overflows its tile is never made worse by this.
 */
function slack(depth, weight = 1) {
  return `${indent(depth)}<FrameLayout
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="0dp"
${indent(depth + 4)}android:layout_weight="${weight}"
${indent(depth + 4)}android:importantForAccessibility="no" />`;
}

/** All-day events are a header line, not a list: "flying to Berlin" is the glance. */
function allDayLine(depth, { sample }) {
  const pad = indent(depth + 4);
  return `${indent(depth)}<TextView
${pad}android:id="@+id/${IDS.allDay}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginTop="4dp"
${pad}android:ellipsize="end"
${pad}android:maxLines="1"${text(pad.length, sample ? sample.allDay : null)}
${pad}android:textColor="@color/ridik_widget_ink"
${pad}android:textSize="12sp"${attr(
    pad.length,
    'visibility',
    sample && sample.allDay ? null : 'gone',
  )} />`;
}

/**
 * The two-pane frame every face shares.
 *
 * The body inflates `gone` and the notice `visible`, which is the honest first
 * frame for a widget that has not been handed a snapshot yet — a plausible
 * sample day drawn before anything was published would be indistinguishable
 * from live data. Previews invert exactly that, and only that.
 */
function face({ ember, body, preview }) {
  const pad = indent(6);
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@android:id/background"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="@drawable/ridik_widget_ground"
    android:padding="12dp">

  <LinearLayout
      android:id="@+id/${IDS.body}"
      android:layout_width="match_parent"
      android:layout_height="match_parent"
      android:orientation="vertical"
      android:visibility="${preview ? 'visible' : 'gone'}">

${body}
  </LinearLayout>

  <LinearLayout
      android:id="@+id/${IDS.notice}"
      android:layout_width="match_parent"
      android:layout_height="match_parent"
      android:gravity="center_vertical"
      android:orientation="vertical"
      android:visibility="${preview ? 'gone' : 'visible'}">

    <TextView
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:fontFamily="monospace"
${pad}android:letterSpacing="0.12"
${pad}android:maxLines="1"
${pad}android:text="RIDIK"
${pad}android:textAllCaps="true"
${pad}android:textColor="@color/${accentColour(ember)}"
${pad}android:textSize="10sp" />

    <TextView
${pad}android:id="@+id/${IDS.noticeTitle}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginTop="5dp"
${pad}android:ellipsize="end"
${pad}android:maxLines="2"
${pad}android:text="Nothing published yet."
${pad}android:textColor="@color/ridik_widget_ink"
${pad}android:textSize="15sp" />

    <TextView
${pad}android:id="@+id/${IDS.noticeBody}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginTop="3dp"
${pad}android:ellipsize="end"
${pad}android:maxLines="3"
${pad}android:text="Open Ridik once and today lands here."
${pad}android:textColor="@color/ridik_widget_ink_soft"
${pad}android:textSize="12sp" />
  </LinearLayout>
</FrameLayout>
`;
}

// ------------------------------------------------------------------ the faces

/** Today: the strip, its ruler, and the next thing under it. */
function todayFace({ ember, size, preview }) {
  const sample = preview ? SAMPLE.today : null;
  const day = preview ? SAMPLE.day : null;
  const body = [
    header(4, sample ? { ember, eyebrow: sample.eyebrow, count: sample.count } : { ember }),
    element(4, { ember, size, sample: day }),
    // Today is the one face with nothing weighted in it, so every dp the
    // launcher gave beyond the strip and the readout collected at the bottom
    // as a void. This is the `Spacer` iOS has between the ruler and the
    // readout: it takes the slack, and on a tile with none it measures zero.
    slack(4),
    nextUp(4, { ember, stacked: size === 'small', sample }),
    copy(4),
  ].join('\n\n');
  return face({ ember, body, preview });
}

/**
 * Calendar: the plate, the strip, and the rows — which of the three depends on
 * the size, and nothing else about the face changes.
 *
 * Staleness here is three branches rather than one, and this is the only Ridik
 * widget that stays honest a week after the app was last opened: the plate goes
 * stale when the month turns over, the strip and the rows when the day does.
 */
function calFace({ ember, size, leadWidth, preview }) {
  const sample = preview ? SAMPLE.cal : null;
  const parts = [
    header(4, sample ? { ember, eyebrow: sample.eyebrow, count: sample.count } : { ember }),
  ];

  if (size === 'small') {
    // No element at this size, so the plate keeps the tile's one hot cell.
    parts.push(plate(4, { ember, size, numerals: false, sample: preview ? SAMPLE.month : null }));
    parts.push(copy(4));
  } else {
    if (size === 'large') {
      // The element below takes the hot cell; today keeps the ring — §3.2.
      parts.push(
        plate(4, {
          ember,
          size,
          numerals: true,
          sample: preview ? SAMPLE.month : null,
          todayIsHot: false,
        }),
      );
    }
    // Under the plate and directly over the strip, as iOS draws it. "Term
    // starts" is a fact about *today*, and above the month it read as a
    // caption on the month — the tile said one thing about August and then a
    // second, unrelated thing about the 13th, in that order.
    parts.push(allDayLine(4, { sample }));
    parts.push(element(4, { ember, size, sample: preview ? SAMPLE.day : null }));
    // The rows sit on the bottom edge and the slack goes above them, which is
    // where iOS's `Spacer` puts it. Weighted rows top-aligned inside a
    // weighted box put every spare dp in one void under the last row instead —
    // on a four-cell tile that is a third of the tile, empty, and it is what
    // "the calendar doesn't fill the widget" looks like from the sofa.
    //
    // The plate above is served first — see `PLATE_WEIGHT`.
    parts.push(slack(4));
    parts.push(copy(4));
    parts.push(rows(4, { ember, slots: ROW_SLOTS_BY_SIZE[size], leadWidth, sample, fill: false }));
  }

  return face({ ember, body: parts.join('\n\n'), preview });
}

function habitsFace({ ember, size, preview }) {
  const sample = preview ? SAMPLE.habits : null;
  const body = [
    header(4, sample ? { ember, eyebrow: sample.eyebrow, count: sample.count } : { ember }),
    copy(4),
    rails(4, { ember, size, sample }),
  ].join('\n\n');
  return face({ ember, body, preview });
}

function tasksFace({ ember, size, leadWidth, preview }) {
  const sample = preview ? SAMPLE.tasks : null;
  // Small draws rows too. It used to draw none — the 40dp debt strip was the
  // whole tile — while iOS drew two from the same payload, which is one widget
  // behaving as two products. The lead is narrower here instead: dropping the
  // rows to buy the lead its 46dp was paying the wrong price.
  const parts = [
    header(4, sample ? { ember, eyebrow: sample.eyebrow, count: sample.count } : { ember }),
    debt(4, { ember, size, sample }),
    footer(4, { sample }),
    slack(4),
    copy(4),
    rows(4, { ember, slots: ROW_SLOTS_BY_SIZE[size], leadWidth, sample, fill: false }),
  ];
  return face({ ember, body: parts.join('\n\n'), preview });
}

function listFace({ ember, size, preview }) {
  const sample = preview ? SAMPLE.list : null;
  const body = [
    header(4, sample ? { ember, eyebrow: sample.eyebrow, count: sample.count } : { ember }),
    // The marks first and the sentence under them — §4, and where iOS puts it.
    // "All twelve done." above the column it is about read as a heading for a
    // list that then contradicted it.
    tickRows(4, { ember, slots: ROW_SLOTS_BY_SIZE[size], sample, fill: false }),
    // Marks at the top, sentence on the bottom edge, air between: the two ends
    // of the tile are occupied, so a tall checklist reads as a tall checklist
    // rather than as a short one with a void under it.
    slack(4),
    copy(4),
  ].join('\n\n');
  return face({ ember, body, preview });
}

/**
 * Every layout the five widgets can inflate.
 *
 * One file per size, one more per size that draws a clock, and all of that
 * again per ember. RemoteViews cannot set a width at runtime and cannot recolour
 * a `TextView` on a build that ships to API 26, so both the lead column and the
 * ember are file names rather than runtime values. `RidikRowsFace.layoutFor` is
 * the other end of these.
 *
 * Sixteen live faces × three embers, plus five previews, is fifty-three files.
 * The previews are the *default* ember alone and deliberately: the gallery is
 * where a widget is judged before one is placed, and it is judged on what a
 * fresh install draws. A picker offering the same tile in three colours would be
 * advertising a choice that lives in Settings.
 */
function layouts() {
  const files = {};

  const build = (widget, size, leadWidth, preview, ember) => {
    switch (widget.kind) {
      case 'today':
        return todayFace({ ember, size, preview });
      case 'agenda':
        return calFace({ ember, size, leadWidth, preview });
      case 'habits':
        return habitsFace({ ember, size, preview });
      case 'tasks':
        return tasksFace({ ember, size, leadWidth, preview });
      default:
        return listFace({ ember, size, preview });
    }
  };

  const lead = (size, ampm) => {
    if (size === 'small') return ampm ? LEAD.narrowAmpm : LEAD.narrow;
    return ampm ? LEAD.ampm : LEAD.wide;
  };

  for (const widget of WIDGETS) {
    for (const size of widget.sizes) {
      for (const ember of EMBER_NAMES) {
        files[`layout/${widget.layout}_${size}_${ember}.xml`] = build(
          widget,
          size,
          lead(size, false),
          false,
          ember,
        );
        if (widget.clocked.includes(size)) {
          files[`layout/${widget.layout}_${size}_ampm_${ember}.xml`] = build(
            widget,
            size,
            lead(size, true),
            false,
            ember,
          );
        }
      }
    }
    files[`layout/${widget.layout}_preview.xml`] = build(
      widget,
      widget.previewSize,
      lead(widget.previewSize, false),
      true,
      DEFAULT_EMBER,
    );
  }

  return files;
}

/**
 * A widget's `appwidget-provider`.
 *
 * Resizable in both directions and down to two cells, because the face reads its
 * own size back at draw time and picks a different layout for it — see
 * `RidikCells.sizeOf`. `updatePeriodMillis` is the platform floor of thirty
 * minutes: everything else is pushed from `RidikWidgets.redrawAll`, but the
 * element has to burn down on a day the app is never opened.
 *
 * `initialLayout` is the *default* ember, because it is what the launcher
 * inflates before the widget has been handed anything at all — at which point
 * nothing has told this process which ember the user picked, and the honest
 * answer is the one a fresh install draws. The first `onUpdate` swaps in the
 * chosen one.
 */
function info(widget) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/${widget.description}"
    android:initialLayout="@layout/${widget.layout}_medium_${DEFAULT_EMBER}"
    android:maxResizeHeight="800dp"
    android:maxResizeWidth="800dp"
    android:minHeight="${widget.cells.height * 55}dp"
    android:minResizeHeight="110dp"
    android:minResizeWidth="140dp"
    android:minWidth="${widget.cells.width * 60}dp"
    android:previewLayout="@layout/${widget.layout}_preview"
    android:resizeMode="horizontal|vertical"
    android:targetCellHeight="${widget.cells.height}"
    android:targetCellWidth="${widget.cells.width}"
    android:updatePeriodMillis="1800000"
    android:widgetCategory="home_screen" />
`;
}

/** `'` ends a string resource unless it is escaped, and `&` is XML on top of that. */
function androidString(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, "\\'");
}

function strings(widgets) {
  const lines = widgets.flatMap((widget) => [
    `  <string name="${widget.label}">${androidString(widget.title)}</string>`,
    `  <string name="${widget.description}">${androidString(widget.blurb)}</string>`,
  ]);
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<resources>
${lines.join('\n')}
</resources>
`;
}

/**
 * Stops resource shrinking from deleting the widget.
 *
 * `shrinkResources` keeps what it can *see* referenced, and every id here is
 * reached through `Resources.getIdentifier(name, …)` — a string R8 cannot
 * follow. Most of the tree survives by accident, because the manifest names the
 * provider XML which names the layout which names its colours; but anything
 * reached only from Kotlin is invisible, and the eight heat drawables are
 * exactly that on any build where no preview happens to use one.
 *
 * The failure would not break the build. It would ship a widget that renders
 * blank, or with one colour resolved to 0 and drawn transparent.
 */
function keepRules() {
  const names = [
    '@layout/ridik_*',
    '@xml/ridik_*',
    '@color/ridik_widget_*',
    '@drawable/ridik_*',
    '@string/ridik_*',
  ];
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<resources xmlns:tools="http://schemas.android.com/tools"
    tools:keep="${names.join(',')}"
    tools:shrinkMode="safe" />
`;
}

/**
 * Every ember's ramp, resolved, one block per option.
 *
 * The same four values per ember live in `src/ui/theme.ts` and — for the default
 * — in `RidikPalette.swift`, and `widget-tokens.test.ts` asserts they agree: a
 * ramp that drifted would put the app's habit grid and the widget beside it in
 * different palettes, on the same screen, with nothing failing.
 *
 * `on_heat` is one shared token rather than three: it is the *inversion* of a
 * hot cell and all three embers give it the same pair.
 */
function emberColors(scheme) {
  return EMBER_NAMES.flatMap((name) => {
    const ramp = EMBERS[name][scheme];
    return [
      `  <color name="${heatColour(name, 0)}">${ramp.cold}</color>`,
      `  <color name="${heatColour(name, 1)}">${ramp.low}</color>`,
      `  <color name="${heatColour(name, 2)}">${ramp.mid}</color>`,
      `  <color name="${heatColour(name, 3)}">${ramp.hot}</color>`,
      `  <color name="${accentColour(name)}">${accentOf(name, scheme)}</color>`,
      `  <color name="ridik_widget_${name}_wash">${washOf(name, scheme)}</color>`,
    ];
  }).join('\n');
}

/**
 * `heat` is the default ember's ramp, written out a second time on purpose.
 *
 * `widget-tokens.test.ts` reads it out of this file as *text* — there is no
 * shared source an Xcode extension, a React Native app and an Android resource
 * file could all import, so the agreement between the three is asserted by
 * reading two of them as strings. Passing `EMBERS.ember[scheme]` here instead
 * would leave nothing for that test to find and it would silently stop checking.
 * The guard below is what makes the duplicate safe.
 */
function colors(scheme, { ground, ink, inkSoft, danger, heat, rim, edge }) {
  const source = { ...EMBERS[DEFAULT_EMBER][scheme], onHeat: ON_HEAT[scheme] };
  for (const level of ['cold', 'low', 'mid', 'hot', 'onHeat']) {
    if (heat[level] !== source[level]) {
      throw new Error(
        `withRidikAndroidWidget: ${scheme} ${level} is ${heat[level]} here and ` +
          `${source[level]} in EMBERS — one of them is a typo.`,
      );
    }
  }

  const optional = [
    rim ? `  <color name="ridik_widget_rim">${rim}</color>` : null,
    edge ? `  <color name="ridik_widget_edge">${edge}</color>` : null,
  ].filter(Boolean);

  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<resources>
  <color name="ridik_widget_ground">${ground}</color>
  <color name="ridik_widget_ink">${ink}</color>
  <color name="ridik_widget_ink_soft">${inkSoft}</color>
  <color name="ridik_widget_danger">${danger}</color>
  <color name="ridik_widget_on_heat">${heat.onHeat}</color>
${optional.length === 0 ? '' : `${optional.join('\n')}\n`}${emberColors(scheme)}
</resources>
`;
}

/**
 * One drawable per heat level, per ember, and a second set for the cell that is
 * today — then all of it again for the month plate, which caps differently.
 *
 * An `ImageView` with one of these as its background is the entire drawing
 * primitive — no bitmaps anywhere in this widget family. Quantising heat into
 * four fixed levels is what makes that possible: a continuous ramp would have
 * forced a `Canvas` bitmap, and with it the ~1MB Binder ceiling and a night-mode
 * seam where the bitmap resolves the *app* process's configuration while the
 * layout's `@color/` references resolve the *launcher's*.
 *
 * The ember is a *name* for the same reason. `Resources.getIdentifier` picks the
 * file, the launcher resolves which config-specific copy of it to load, and no
 * colour is ever resolved in this app's process — which is the whole night-mode
 * fix applied to a second axis.
 *
 * A `-night` file is written only where it would actually differ from the day
 * one, so the count stays honest. Two things make it differ: level 3's hairline,
 * which is a 1dp inset of the ground in light so the hot cell does not touch its
 * neighbours and a 1dp rim in dark so emission reads as glow; and the plate's
 * `platePeak` cap, which applies in light only.
 */
function cellDrawables() {
  const files = {};

  const write = (name, make) => {
    const day = make('light');
    const night = make('dark');
    files[`drawable/${name}.xml`] = day;
    if (night !== day) files[`drawable-night/${name}.xml`] = night;
  };

  for (const ember of EMBER_NAMES) {
    for (let level = 0; level < 4; level++) {
      for (const today of [false, true]) {
        write(heatDrawable(ember, level, today), (scheme) =>
          cellShape(ember, level, level, { today, scheme }),
        );
        write(plateDrawable(ember, level, today), (scheme) =>
          cellShape(ember, level, plateLevel(ember, level, scheme), { today, scheme }),
        );
      }
    }
  }

  return files;
}

/**
 * `level` is what the cell *means*; `fill` is the ramp step it is allowed to
 * reach. They are the same everywhere except a capped ember's month plate in
 * light mode — see `plateDrawable`. The hairline follows `level`, because a cell
 * standing for `hot` keeps its rim whatever it had to be filled with.
 */
function cellShape(ember, level, fill, { today, scheme }) {
  // The ring goes on top of the fill on the plate's today cell, so the day it
  // marks is not made smaller than the ones around it.
  const stroke = today
    ? `\n  <stroke android:width="1.5dp" android:color="@color/${accentColour(ember)}" />`
    : level === 3
      ? `\n  <stroke android:width="1dp" android:color="@color/ridik_widget_${scheme === 'dark' ? 'rim' : 'ground'}" />`
      : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="rectangle">
  <solid android:color="@color/${heatColour(ember, fill)}" />
  <corners android:radius="2dp" />${stroke}
</shape>
`;
}

/**
 * The tile itself.
 *
 * Dark carries a 1dp border and light carries none: a near-black tile on a dark
 * photo wallpaper otherwise dissolves into it. That is a defect fix, not a
 * flourish, which is why it is here and not in a theme.
 */
function ground(radius, { night }) {
  const stroke = night
    ? '\n  <stroke android:width="1dp" android:color="@color/ridik_widget_edge" />'
    : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="rectangle">
  <solid android:color="@color/ridik_widget_ground" />
  <corners android:radius="${radius}" />${stroke}
</shape>
`;
}

function resourceFiles() {
  // Android 12 clips widgets to a corner radius it picks itself. Matching it is
  // the difference between a rounded card and a rounded card with a sliver of
  // wallpaper showing through each corner.
  const SYSTEM_RADIUS = '@android:dimen/system_app_widget_background_radius';

  return {
    ...layouts(),
    ...cellDrawables(),

    ...Object.fromEntries(
      WIDGETS.map((widget) => [`xml/${widget.info}.xml`, info(widget)]),
    ),

    'values/ridik_widget_strings.xml': strings(WIDGETS.filter((w) => w.kind === 'today')),
    'values/ridik_rows_strings.xml': strings(WIDGETS.filter((w) => w.kind !== 'today')),

    'raw/ridik_widget_keep.xml': keepRules(),

    // Warm sand and a warm near-black, the same ground every screen in the app
    // sits on. Nothing here is a neutral grey; on this palette one would read
    // as a bug. The ground, the ink and the tile's furniture are the same under
    // every ember — only the heat changes, which is the whole point of a
    // palette built from one colour at four opacities.
    'values/ridik_widget_colors.xml': colors('light', {
      ground: '#FFE8D4',
      ink: '#2E1508',
      inkSoft: '#BD2E1508',
      danger: '#BE2A18',
      // #C7360F over #FFE8D4 at 23 / 46 / 70 / 100 percent — the default
      // ember's own ramp. The resting cell is deliberately higher than it looks
      // it should be — see theme.ts.
      heat: {
        cold: '#F2BFA7',
        low: '#E59679',
        mid: '#D86B4A',
        hot: '#C7360F',
        onHeat: '#FFF7F0',
      },
    }),

    // The launcher can be in dark mode while the app is not, so the widget
    // answers to the system rather than to the app's own scheme.
    'values-night/ridik_widget_colors.xml': colors('dark', {
      ground: '#1C0E06',
      ink: '#FFEEDF',
      inkSoft: '#A8FFEEDF',
      danger: '#FF6F5C',
      // Dark only: a hairline inside the hot cell so emission reads as glow,
      // and a tile border, because a near-black tile on a dark photo wallpaper
      // otherwise dissolves into it. Both are furniture and neither follows the
      // ember — a 1dp hairline is read as light, not as a colour.
      rim: '#FFB57E',
      edge: '#1FFFD6B8',
      // #FF5A36 over #1C0E06 at the same four. Note the hot value is the vivid
      // core, not the accent — the accent is the text-safe lightened one.
      heat: {
        cold: '#501F11',
        low: '#84311C',
        mid: '#BB4328',
        hot: '#FF5A36',
        onHeat: '#1C0E06',
      },
    }),

    'drawable/ridik_widget_ground.xml': ground('20dp', { night: false }),
    'drawable-v31/ridik_widget_ground.xml': ground(SYSTEM_RADIUS, { night: false }),
    'drawable-night/ridik_widget_ground.xml': ground('20dp', { night: true }),
    'drawable-night-v31/ridik_widget_ground.xml': ground(SYSTEM_RADIUS, { night: true }),
  };
}

/**
 * Deletes anything this file used to write and no longer does.
 *
 * `android/` is not wiped between prebuilds unless `--clean` is passed, so a
 * layout that was renamed leaves its predecessor behind — still compiling,
 * still referencing ids nothing sets, and still the file the launcher inflates
 * if a stale provider XML happens to name it. Every generated file is prefixed
 * `ridik_`, which is what makes this safe to sweep.
 */
function prune(res, generated) {
  const keep = new Set(Object.keys(generated).map((relative) => path.normalize(relative)));
  if (!fs.existsSync(res)) return;
  for (const folder of fs.readdirSync(res)) {
    const directory = path.join(res, folder);
    if (!fs.statSync(directory).isDirectory()) continue;
    for (const file of fs.readdirSync(directory)) {
      if (!/^ridik_.*\.xml$/.test(file)) continue;
      const relative = path.normalize(`${folder}/${file}`);
      if (!keep.has(relative)) fs.unlinkSync(path.join(directory, file));
    }
  }
}

const withWidgetResources = (config) =>
  withDangerousMod(config, [
    'android',
    (config) => {
      const res = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');
      const files = resourceFiles();
      prune(res, files);
      for (const [relative, contents] of Object.entries(files)) {
        const file = path.join(res, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents, 'utf8');
      }
      return config;
    },
  ]);

/**
 * One receiver per widget: Android identifies a widget by its provider class,
 * so five widgets is five classes and five entries here.
 *
 * The system, not another app, is what broadcasts APPWIDGET_UPDATE, and it can
 * only reach an exported receiver. Nothing is trusted from the broadcast
 * itself — every redraw re-reads the app's own preferences.
 */
function receiver(widget) {
  return {
    $: {
      'android:name': widget.provider,
      'android:exported': 'true',
      'android:label': `@string/${widget.label}`,
    },
    'intent-filter': [
      { action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }] },
    ],
    'meta-data': [
      {
        $: {
          'android:name': 'android.appwidget.provider',
          'android:resource': `@xml/${widget.info}`,
        },
      },
    ],
  };
}

const withWidgetReceiver = (config) =>
  withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error('withRidikAndroidWidget: the manifest has no <application> to add to.');
    }

    const ours = WIDGETS.map(receiver);
    const names = new Set(ours.map((entry) => entry.$['android:name']));
    // Filtered rather than appended, so a second prebuild over an existing
    // `android/` does not leave two receivers for the same class.
    application.receiver = [
      ...(application.receiver ?? []).filter(
        (existing) => !names.has(existing.$?.['android:name'])
      ),
      ...ours,
    ];
    return config;
  });

/**
 * More heap for the build, because these layouts are why it needs it.
 *
 * Five faces at five sizes generated twenty-one layouts, and the largest — a
 * six-rail board of thirty-five days — is a quarter of a megabyte of XML.
 * Together with React Native's own dex that was already more than the
 * template's 2GB, and D8 fails with a bare `OutOfMemoryError: Java heap space`
 * that says nothing about the number being configurable.
 *
 * A user-chosen ember triples the sixteen *live* faces, because text colour
 * lives in the layout and RemoteViews cannot restyle a `TextView` on a build
 * that ships to API 26 — fifty-three files and about 2.1MB of XML through
 * aapt2. Measured: 6GB still carries it with room to spare, so the number is
 * unchanged. It is stated here rather than in the app config because this
 * plugin is the only reason it is needed at all.
 */
const withBuildHeap = (config) =>
  withGradleProperties(config, (cfg) => {
    const key = 'org.gradle.jvmargs';
    const kept = cfg.modResults.filter((entry) => entry.key !== key);
    kept.push({
      type: 'property',
      key,
      value: '-Xmx6144m -XX:MaxMetaspaceSize=1024m',
    });
    cfg.modResults = kept;
    return cfg;
  });

module.exports = function withRidikAndroidWidget(config) {
  return withBuildHeap(withWidgetReceiver(withWidgetResources(config)));
};
