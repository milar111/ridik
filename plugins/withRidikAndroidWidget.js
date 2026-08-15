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
  rowTrail: (i) => `ridik_row_trail_${i}`,
  tick: (i) => `ridik_tick_${i}`,
};

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

/** Must equal `ROW_CAP` in `snapshot.ts` and `ROW_SLOTS` in `RidikCells.kt`. */
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
 */
const LEAD = { wide: 46, ampm: 62 };

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
  small: { name: 84, streak: 0, best: 0 },
  medium: { name: 68, streak: 26, best: 0 },
  large: { name: 64, streak: 24, best: 30 },
};

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
    timed: false,
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
    timed: true,
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
    timed: false,
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
    timed: true,
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
    timed: false,
    cells: { width: 3, height: 3 },
  },
];

// ----------------------------------------------------------------- the sample
/**
 * What the widget picker shows.
 *
 * The picker cannot run any of our code, so the only way to show it a plausible
 * widget is to bake one into a second layout — and "the widgets look blank" is
 * judged there, before a tile is ever placed. The copy is lifted verbatim from
 * `WIDGETS.md` §3 so that both platforms ship the same fake day.
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
    sub: 'leave in 34 min · Studio 2',
  },
  cal: {
    // The month is the eyebrow and the day is the number beside it — §3.2, and
    // the same header iOS draws. No count: `agenda` is capped at six by the
    // publisher, so "6 LEFT" would be a claim the payload cannot support.
    eyebrow: 'AUGUST',
    count: 'THU 13',
    rows: [
      { lead: '15:00', text: 'Materials lab', trail: 'Studio 2' },
      { lead: '17:30', text: 'Studio clean-up', trail: null },
      { lead: '19:00', text: 'Dinner with Ana', trail: null },
    ],
  },
  habits: {
    eyebrow: 'HABITS',
    count: '2/6',
    rails: [
      { name: 'Run', streak: '12d', history: '011111111111111111111' },
      { name: 'Read', streak: '4d', history: '100110011100111100111' },
      { name: 'Water', streak: null, history: '000001100011100111110' },
      { name: 'Stretch', streak: null, history: '001000010000100001000' },
      { name: 'Journal', streak: null, history: '110001100011000110010' },
      { name: 'Vitamin', streak: null, history: '000000000000000000000' },
    ],
  },
  tasks: {
    eyebrow: 'TASKS',
    count: '2 LATE',
    // Oldest left, one cell per open task; only the oldest overdue is hot.
    debt: '321000000000',
    footLeft: 'oldest 9d',
    footRight: '12 open',
    rows: [
      { lead: '9d', text: 'Return the drill to Sam', trail: null },
      { lead: '2d', text: 'Email the tutor about the resit', trail: null },
      { lead: '17:00', text: 'Submit the parts form', trail: null },
    ],
  },
  list: {
    eyebrow: 'HARDWARE',
    count: '3 OF 5',
    rows: [
      { text: 'M4 bolts ×20', done: false },
      { text: 'Threadlock', done: false },
      { text: 'Sanding discs', done: false },
      { text: 'Masking tape', done: true },
      { text: 'Wood glue', done: true },
    ],
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
function cell(depth, { id, level = 0, width, height, weight, marginEnd, marginStart, gravity, hidden }) {
  const pad = indent(depth + 4);
  return `${indent(depth)}<ImageView
${pad}android:id="@+id/${id}"
${pad}android:layout_width="${width}"
${pad}android:layout_height="${height}"${attr(depth + 4, 'layout_weight', weight)}${attr(
    depth + 4,
    'layout_marginEnd',
    marginEnd,
  )}${attr(depth + 4, 'layout_marginStart', marginStart)}${attr(depth + 4, 'layout_gravity', gravity)}
${pad}android:background="@drawable/ridik_heat_${level}"
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
function header(depth, { eyebrow, count } = {}) {
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
${indent(depth + 6)}android:textColor="@color/ridik_widget_ember"
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
${indent(depth + 6)}android:textColor="@color/ridik_widget_ember"
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
function element(depth, { size, sample }) {
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
      level,
      width: 'match_parent',
      height: 'match_parent',
      hidden: spent,
    })}

${cell(depth + 4, {
      id: IDS.cellSpent(i),
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
 * load level. That ring is only visible at all this way: `ridik_widget_ember`
 * and `ridik_widget_heat_3` are the same `#C7360F` in light mode, so a ring
 * around a hot fill is a ring around nothing.
 */
function plate(depth, { numerals, sample, todayIsHot = true }) {
  const heads = WEEKDAYS.map((day, index) => {
    const pad = indent(depth + 6);
    return `${indent(depth + 2)}<TextView
${pad}android:layout_width="0dp"
${pad}android:layout_height="wrap_content"
${pad}android:layout_weight="1"${index === WEEKDAYS.length - 1 ? '' : `\n${pad}android:layout_marginEnd="2dp"`}
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
${pad}android:layout_height="match_parent"
${pad}android:layout_weight="1"${column === 6 ? '' : `\n${pad}android:layout_marginEnd="2dp"`}
${pad}android:background="@drawable/ridik_heat_${level}${today ? '_today' : ''}"
${pad}android:fontFamily="monospace"
${pad}android:gravity="center"
${pad}android:includeFontPadding="false"
${pad}android:maxLines="1"${text(depth + 6, day)}
${pad}android:textColor="@color/${
        today && todayIsHot ? 'ridik_widget_on_heat' : 'ridik_widget_ink'
      }"
${pad}android:textSize="${numerals ? '11sp' : '1sp'}"${attr(
        depth + 6,
        'visibility',
        hidden ? 'invisible' : null,
      )} />`);
    }

    weeks.push(`${indent(depth + 2)}<LinearLayout
${indent(depth + 6)}android:id="@+id/${IDS.plateWeek(week)}"
${indent(depth + 6)}android:layout_width="match_parent"
${indent(depth + 6)}android:layout_height="0dp"
${indent(depth + 6)}android:layout_marginTop="2dp"
${indent(depth + 6)}android:layout_weight="1"
${indent(depth + 6)}android:orientation="horizontal">

${days.join('\n\n')}
${indent(depth + 2)}</LinearLayout>`);
  }

  return `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:id="@+id/${IDS.plateArea}"
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="0dp"
${indent(depth + 4)}android:layout_marginTop="5dp"
${indent(depth + 4)}android:layout_weight="1"
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
function rails(depth, { size, sample }) {
  const days = RAIL_DAYS[size];
  const gutter = GUTTER[size];
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
${pad}android:maxHeight="${RAIL_HEIGHT[size]}dp"
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
 */
function debt(depth, { size, sample }) {
  const slots = DEBT_SLOTS[size];
  const height = size === 'small' ? 40 : 24;
  const cells = Array.from({ length: slots }, (_, index) =>
    cell(depth + 2, {
      id: IDS.debt(index),
      level: sample ? Number(sample.debt[index] || 0) : 0,
      width: '0dp',
      height: 'match_parent',
      weight: '1',
      marginEnd: index === slots - 1 ? null : '2dp',
    }),
  );

  return `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:id="@+id/${IDS.debtArea}"
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="${height}dp"
${indent(depth + 4)}android:layout_marginTop="7dp"
${indent(depth + 4)}android:orientation="horizontal">

${cells.join('\n\n')}
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
 */
function rows(depth, { slots, leadWidth, sample }) {
  const drawn = [];
  for (let index = 0; index < slots; index++) {
    const row = sample ? sample.rows[index] : null;
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
${indent(depth + 8)}android:textColor="@color/ridik_widget_ember"
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
${indent(depth + 4)}android:layout_height="0dp"
${indent(depth + 4)}android:layout_marginTop="7dp"
${indent(depth + 4)}android:layout_weight="1"
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
function tickRows(depth, { slots, sample }) {
  const drawn = [];
  for (let index = 0; index < slots; index++) {
    const row = sample ? sample.rows[index] : null;
    const pad = indent(depth + 6);
    drawn.push(`${indent(depth + 2)}<LinearLayout
${pad}android:id="@+id/${IDS.row(index)}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"${index === 0 ? '' : `\n${pad}android:layout_marginTop="6dp"`}
${pad}android:gravity="center_vertical"
${pad}android:orientation="horizontal"${attr(pad.length, 'visibility', row ? null : 'gone')}>

${cell(depth + 4, {
      id: IDS.tick(index),
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
${indent(depth + 8)}android:textColor="@color/ridik_widget_${row && row.done ? 'ink_soft' : 'ink'}"
${indent(depth + 8)}android:textSize="13sp" />
${indent(depth + 2)}</LinearLayout>`);
  }

  return `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:id="@+id/${IDS.rowArea}"
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="0dp"
${indent(depth + 4)}android:layout_marginTop="8dp"
${indent(depth + 4)}android:layout_weight="1"
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
function nextUp(depth, { stacked, sample }) {
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
${inner}android:textSize="${stacked ? '22' : '19'}sp" />`;

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
${pad}android:textColor="@color/ridik_widget_ember"
${pad}android:textSize="11sp"
${pad}android:visibility="gone" />

${indent(depth + 2)}<TextView
${pad}android:id="@+id/${IDS.nextSub}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginTop="3dp"
${pad}android:ellipsize="end"
${pad}android:maxLines="1"${text(pad.length, sample ? sample.sub : null)}
${pad}android:textColor="@color/ridik_widget_ember"
${pad}android:textSize="11sp"${attr(pad.length, 'visibility', sample ? null : 'gone')} />
${indent(depth)}</LinearLayout>`;
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
${pad}android:textSize="12sp"
${pad}android:visibility="gone" />`;
}

/**
 * The two-pane frame every face shares.
 *
 * The body inflates `gone` and the notice `visible`, which is the honest first
 * frame for a widget that has not been handed a snapshot yet — a plausible
 * sample day drawn before anything was published would be indistinguishable
 * from live data. Previews invert exactly that, and only that.
 */
function face({ body, preview }) {
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
${pad}android:textColor="@color/ridik_widget_ember"
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
function todayFace({ size, preview }) {
  const sample = preview ? SAMPLE.today : null;
  const day = preview ? SAMPLE.day : null;
  const body = [
    header(4, sample ? { eyebrow: sample.eyebrow, count: sample.count } : {}),
    element(4, { size, sample: day }),
    nextUp(4, { stacked: size === 'small', sample }),
    copy(4),
  ].join('\n\n');
  return face({ body, preview });
}

/**
 * Calendar: the plate, the strip, and the rows — which of the three depends on
 * the size, and nothing else about the face changes.
 *
 * Staleness here is three branches rather than one, and this is the only Ridik
 * widget that stays honest a week after the app was last opened: the plate goes
 * stale when the month turns over, the strip and the rows when the day does.
 */
function calFace({ size, leadWidth, preview }) {
  const sample = preview ? SAMPLE.cal : null;
  const parts = [header(4, sample ? { eyebrow: sample.eyebrow, count: sample.count } : {})];

  if (size === 'small') {
    // No element at this size, so the plate keeps the tile's one hot cell.
    parts.push(plate(4, { numerals: false, sample: preview ? SAMPLE.month : null }));
    parts.push(copy(4));
  } else {
    parts.push(allDayLine(4, { sample }));
    if (size === 'large') {
      // The element below takes the hot cell; today keeps the ring — §3.2.
      parts.push(
        plate(4, { numerals: true, sample: preview ? SAMPLE.month : null, todayIsHot: false }),
      );
    }
    parts.push(element(4, { size, sample: preview ? SAMPLE.day : null }));
    parts.push(copy(4));
    parts.push(rows(4, { slots: ROW_SLOTS_BY_SIZE[size], leadWidth, sample }));
  }

  return face({ body: parts.join('\n\n'), preview });
}

function habitsFace({ size, preview }) {
  const sample = preview ? SAMPLE.habits : null;
  const body = [
    header(4, sample ? { eyebrow: sample.eyebrow, count: sample.count } : {}),
    copy(4),
    rails(4, { size, sample }),
  ].join('\n\n');
  return face({ body, preview });
}

function tasksFace({ size, leadWidth, preview }) {
  const sample = preview ? SAMPLE.tasks : null;
  const parts = [
    header(4, sample ? { eyebrow: sample.eyebrow, count: sample.count } : {}),
    debt(4, { size, sample }),
    footer(4, { sample }),
    copy(4),
  ];
  // Small has no rows: a 46dp lead on a two-cell tile leaves the title nothing,
  // so the debt cells get the height instead and the footer carries the count.
  if (size !== 'small') parts.push(rows(4, { slots: ROW_SLOTS_BY_SIZE[size], leadWidth, sample }));
  return face({ body: parts.join('\n\n'), preview });
}

function listFace({ size, preview }) {
  const sample = preview ? SAMPLE.list : null;
  const body = [
    header(4, sample ? { eyebrow: sample.eyebrow, count: sample.count } : {}),
    copy(4),
    tickRows(4, { slots: ROW_SLOTS_BY_SIZE[size], sample }),
  ].join('\n\n');
  return face({ body, preview });
}

/**
 * Every layout the five widgets can inflate.
 *
 * One file per size, and one more per size that draws a clock, because
 * RemoteViews cannot set a width at runtime and "3:15 PM" needs half again the
 * lead column of "15:15". `RidikRowsFace.layoutFor` is the other end of these
 * names.
 */
function layouts() {
  const files = {};

  const build = (widget, size, leadWidth, preview) => {
    switch (widget.kind) {
      case 'today':
        return todayFace({ size, preview });
      case 'agenda':
        return calFace({ size, leadWidth, preview });
      case 'habits':
        return habitsFace({ size, preview });
      case 'tasks':
        return tasksFace({ size, leadWidth, preview });
      default:
        return listFace({ size, preview });
    }
  };

  for (const widget of WIDGETS) {
    for (const size of widget.sizes) {
      files[`layout/${widget.layout}_${size}.xml`] = build(widget, size, LEAD.wide, false);
      if (widget.timed && size !== 'small') {
        files[`layout/${widget.layout}_${size}_ampm.xml`] = build(widget, size, LEAD.ampm, false);
      }
    }
    files[`layout/${widget.layout}_preview.xml`] = build(widget, widget.previewSize, LEAD.wide, true);
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
 */
function info(widget) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/${widget.description}"
    android:initialLayout="@layout/${widget.layout}_medium"
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
 * The cell ramp, resolved, plus the two dark-only tokens.
 *
 * The same four values live in `src/ui/theme.ts` and `RidikPalette.swift`, and
 * `widget-tokens.test.ts` asserts all three agree — a ramp that drifted would
 * put the app's habit grid and the widget beside it in different palettes, on
 * the same screen, with nothing failing.
 */
function heatColors({ cold, low, mid, hot, onHeat, rim, edge }) {
  const optional = [
    rim ? `  <color name="ridik_widget_rim">${rim}</color>` : null,
    edge ? `  <color name="ridik_widget_edge">${edge}</color>` : null,
  ].filter(Boolean);
  return [
    `  <color name="ridik_widget_heat_0">${cold}</color>`,
    `  <color name="ridik_widget_heat_1">${low}</color>`,
    `  <color name="ridik_widget_heat_2">${mid}</color>`,
    `  <color name="ridik_widget_heat_3">${hot}</color>`,
    `  <color name="ridik_widget_on_heat">${onHeat}</color>`,
    ...optional,
  ].join('\n');
}

function colors({ ground, ink, inkSoft, ember, danger, wash, heat }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<resources>
  <color name="ridik_widget_ground">${ground}</color>
  <color name="ridik_widget_ink">${ink}</color>
  <color name="ridik_widget_ink_soft">${inkSoft}</color>
  <color name="ridik_widget_ember">${ember}</color>
  <color name="ridik_widget_danger">${danger}</color>
  <color name="ridik_widget_wash">${wash}</color>
${heatColors(heat)}
</resources>
`;
}

/**
 * One drawable per heat level, and a second set for the cell that is today.
 *
 * An `ImageView` with one of these as its background is the entire drawing
 * primitive — no bitmaps anywhere in this widget family. Quantising heat into
 * four fixed levels is what makes that possible: a continuous ramp would have
 * forced a `Canvas` bitmap, and with it the ~1MB Binder ceiling and a night-mode
 * seam where the bitmap resolves the *app* process's configuration while the
 * layout's `@color/` references resolve the *launcher's*.
 *
 * Level 3 is the only one that differs between schemes, and it differs for
 * opposite reasons: light takes a 1dp inset of the ground so the hot cell does
 * not touch its neighbours, dark takes a 1dp rim so emission reads as glow.
 */
function cellDrawables() {
  const files = {};
  for (let level = 0; level < 4; level++) {
    files[`drawable/ridik_heat_${level}.xml`] = cellShape(level, { today: false });
    files[`drawable/ridik_heat_${level}_today.xml`] = cellShape(level, { today: true });
    if (level === 3) {
      files[`drawable-night/ridik_heat_${level}.xml`] = cellShape(level, { today: false, night: true });
      files[`drawable-night/ridik_heat_${level}_today.xml`] = cellShape(level, {
        today: true,
        night: true,
      });
    }
  }
  return files;
}

function cellShape(level, { today, night }) {
  // The ring goes on top of the fill on the plate's today cell, so the day it
  // marks is not made smaller than the ones around it.
  const stroke = today
    ? '\n  <stroke android:width="1.5dp" android:color="@color/ridik_widget_ember" />'
    : level === 3
      ? `\n  <stroke android:width="1dp" android:color="@color/ridik_widget_${night ? 'rim' : 'ground'}" />`
      : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="rectangle">
  <solid android:color="@color/ridik_widget_heat_${level}" />
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
    // as a bug.
    'values/ridik_widget_colors.xml': colors({
      ground: '#FFE8D4',
      ink: '#2E1508',
      inkSoft: '#BD2E1508',
      ember: '#C7360F',
      danger: '#BE2A18',
      wash: '#1FC7360F',
      // #C7360F over #FFE8D4 at 23 / 46 / 70 / 100 percent. The resting cell
      // is deliberately higher than it looks it should be — see theme.ts.
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
    'values-night/ridik_widget_colors.xml': colors({
      ground: '#1C0E06',
      ink: '#FFEEDF',
      inkSoft: '#A8FFEEDF',
      ember: '#FF8253',
      danger: '#FF6F5C',
      wash: '#29FF8253',
      // #FF5A36 over #1C0E06 at the same four. Note the hot value is the vivid
      // core, not `ember` — the accent is the text-safe darkened one.
      heat: {
        cold: '#501F11',
        low: '#84311C',
        mid: '#BB4328',
        hot: '#FF5A36',
        onHeat: '#1C0E06',
        // Dark only: a hairline inside the hot cell so emission reads as glow,
        // and a tile border, because a near-black tile on a dark photo
        // wallpaper otherwise dissolves into it.
        rim: '#FFB57E',
        edge: '#1FFFD6B8',
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
 * Five faces generate about nineteen layouts, and the largest — a six-rail
 * board of thirty-five days — is over two thousand views of XML. Together with
 * React Native's own dex that is more than the template's 2GB, and D8 fails
 * with a bare `OutOfMemoryError: Java heap space` that says nothing about the
 * number being configurable. It belongs here rather than in the app config
 * because this plugin is what made it necessary.
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
