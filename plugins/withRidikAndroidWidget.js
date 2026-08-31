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
  /**
   * The one *control* in the family, and the only view on a tile that opens
   * something other than the screen the tile is about.
   *
   * It is a second click target, which RemoteViews does support: a child with
   * its own `setOnClickPendingIntent` takes the touch before the root's. Only
   * medium and large carry it — see `header()` for why small does not.
   */
  mic: 'ridik_mic',
  headline: 'ridik_headline',
  sub: 'ridik_sub',
  allDay: 'ridik_allday',
  next: 'ridik_next',
  readout: 'ridik_readout',
  nextTitle: 'ridik_next_title',
  nextSub: 'ridik_next_sub',
  timer: 'ridik_timer',
  /**
   * The word under the live digits — "to leave" / "to go" / "on this break".
   *
   * Its own view rather than a prefix inside the `Chronometer`'s format string.
   * A `Chronometer` renders one line, so "starts in 34:12" set at 34sp is
   * fifteen monospace characters and runs off the tile; and the *verb* is not
   * the reading, it is the label on it. iOS sets the same word the same way.
   */
  timerNote: 'ridik_timer_note',
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
  /**
   * Now / Next / Later — three slots, each a label over a bar over a time and a
   * title. Their own ids rather than the row ids: a row is a horizontal line and
   * these are vertical columns, and reusing `ridik_row_<n>` for both would make
   * `drawRows` able to address the wrong face's views by accident.
   */
  slotArea: 'ridik_slots',
  /**
   * The completion rings. `ridik_ring_<n>` is an `ImageView` the Kotlin fills
   * with a generated bitmap; the percentage sits in its own view beside it
   * rather than being painted into the bitmap, so the *text* stays a real
   * `TextView` the launcher colours and a screen reader can reach.
   */
  ringArea: 'ridik_rings',
  /**
   * The week as seven cells — the Chain face.
   *
   * The weekday letters above them carry no id at all, because Monday-first is
   * not a thing the payload can change: `buildWeek` fixes the order and the
   * layout states it. Only the dates move, so only the dates are addressed.
   */
  /**
   * The one `ImageView` on each of the four rastered faces.
   *
   * Sundial's arc, Horizon's skyline, Route's segments and Term's dot field are
   * each a single bitmap, because `RemoteViews` cannot set a width or a height
   * before API 31, cannot draw a curve at all, and cannot hold 365 views. See
   * `RidikPlots.kt` for why the bitmap is a white mask and never a colour.
   */
  plot: 'ridik_plot',
  plotNote: 'ridik_plot_note',
  chainArea: 'ridik_chain',
  chain: (i) => `ridik_chain_${i}`,
  chainDate: (i) => `ridik_chain_date_${i}`,
  ring: (i) => `ridik_ring_${i}`,
  ringValue: (i) => `ridik_ring_value_${i}`,
  ringName: (i) => `ridik_ring_name_${i}`,
  slotLabel: (i) => `ridik_slot_label_${i}`,
  slotBar: (i) => `ridik_slot_bar_${i}`,
  slotTime: (i) => `ridik_slot_time_${i}`,
  slotTitle: (i) => `ridik_slot_title_${i}`,
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
  // #C7360F / #FF5A36 at 29 / 50 / 72 / 100 percent, over the TILE.
  ember: {
    light: { cold: '#F2CBBD', low: '#E59E89', mid: '#D86F52', hot: '#C7360F' },
    dark: { cold: '#4F2216', low: '#82321F', mid: '#B84329', hot: '#FF5A36' },
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
  // #A82318 / #F04B3C at 28 / 50 / 74 / 100, over the TILE.
  kiln: {
    light: { cold: '#EAC4BD', low: '#D6928A', mid: '#C15F56', hot: '#A82318' },
    dark: { cold: '#4f1f18', low: '#822D24', mid: '#B83C30', hot: '#F04B3C' },
    accent: { light: '#A82318', dark: '#F04B3C' },
    platePeak: 'low',
  },
  // #96341A / #DE6038 at the same four.
  rust: {
    light: { cold: '#E4C5BA', low: '#CA9585', mid: '#B16651', hot: '#96341A' },
    dark: { cold: '#492417', low: '#783721', mid: '#AA4B2D', hot: '#DE6038' },
    accent: { light: '#96341A', dark: '#DE6038' },
    platePeak: 'low',
  },
};

const EMBER_NAMES = Object.keys(EMBERS);

/** What a fresh install draws, and the one the gallery preview is built from. */
const DEFAULT_EMBER = 'ember';

/**
 * The default ember's ramp, as the tile's own `heat` block wants it.
 *
 * `onHeat` is `TILE`, and that is not a coincidence to be tidied away later: an
 * inverted numeral is the ground showing *through* a lit cell, so if these two
 * ever stop being the same pair, one of them is a typo.
 */
function defaultHeat(scheme) {
  return { ...EMBERS[DEFAULT_EMBER][scheme], onHeat: TILE[scheme] };
}

/**
 * The widget's own ground, and why it is not the app's.
 *
 * The app is a saturated warm field because it is a hero screen. A widget is a
 * guest on somebody else's home screen, sitting between other apps' tiles, and
 * the same saturation there reads as shouting — every well-made widget in the
 * wild is pale for this reason. It also measures better: the ramp resolved
 * against this tile separates a resting cell from its own ground at 1.56:1
 * where the app's `bg` gave 1.39:1. The tile being too saturated is what made
 * empty widgets look washed out; raising the ember was treating the symptom.
 *
 * `src/ui/theme.ts` → `tile` is the other end of this pair.
 */
const TILE = { light: '#FFF7F1', dark: '#17100C' };

/**
 * Fully transparent, for a colour that a scheme deliberately does not draw.
 *
 * Every colour a `drawable/` names has to exist in the base `values/` folder,
 * because `drawable/` carries no configuration qualifier of its own: a colour
 * defined only in `values-night/` has no value at all on a light device and
 * throws when the launcher asks for it. So "this scheme has no border" is stated
 * as a border of nothing, never as a missing resource.
 */
const NOTHING = '#00000000';

/**
 * Depth, as three neutral values and one coloured one — `src/ui/theme.ts` →
 * `depth`, which is where they were solved.
 *
 * A widget cannot cast a shadow and on Android it cannot even ask, so depth is
 * made out of edges: a dark lip at the top of a track, a light one at its floor,
 * a highlight along the top of a lit cell, and one soft bloom in a corner. Dark
 * needs roughly double the alpha — the same white over near-black moves a
 * fraction as far in perceived lightness as it does over linen.
 *
 * The three neutrals are shared by every ember because they are light and not
 * colour. The bloom is not: it is the ember itself at 12% (light) or 24%
 * (dark), so a rust tile is bloomed rust and not orange.
 */
const DEPTH = {
  light: { well: '#14000000', wellFloor: '#B3FFFFFF', bevel: '#66FFFFFF', bloom: '1F' },
  dark: { well: '#38000000', wellFloor: '#14FFFFFF', bevel: '#26FFFFFF', bloom: '3D' },
};

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

/**
 * The corner bloom's centre, and the same colour at zero alpha for it to fade
 * into.
 *
 * The stop it fades to has to be *this* hue at `00` and never
 * `@android:color/transparent`, which is transparent **black**: interpolating
 * toward it drags every midpoint of the falloff through grey, and a grey haze
 * over a warm tile is the one thing this palette says reads as a bug.
 *
 * The ramp's own `hot` rather than the accent, on every ember including the
 * default — a bloom is emission, and `accent` is the darkened text-safe one.
 */
const bloomOf = (ember, scheme) => `#${DEPTH[scheme].bloom}${EMBERS[ember][scheme].hot.slice(1)}`;
const bloomOutOf = (ember, scheme) => `#00${EMBERS[ember][scheme].hot.slice(1)}`;

const accentColour = (ember) => `ridik_widget_${ember}_accent`;
const heatColour = (ember, level) => `ridik_widget_${ember}_heat_${level}`;
const bloomColour = (ember) => `ridik_widget_${ember}_bloom`;
const groundDrawable = (ember) => `ridik_widget_ground_${ember}`;

/** The recessed track every cell run sits inside. Neutral, so one file serves all. */
const WELL = 'ridik_well';

/**
 * The microphone glyph, and the label a screen reader reads instead of it.
 *
 * One file for all three embers because it is drawn white and tinted by the
 * `ImageView` in the layout, and the layouts are already per-ember. A tint is a
 * colour *reference*, resolved by whoever inflates the view — which is the
 * launcher, in its own night mode, which is the only correct answer.
 */
const MIC_DRAWABLE = 'ridik_widget_mic';
const MIC_LABEL = 'ridik_widget_speak_label';

/**
 * What the Quick Settings tile is called, which is not what the widget's mic is
 * called: a `contentDescription` is read out in a sentence ("Speak to Ridik,
 * button") while a tile label is a caption under an icon in a grid about ten
 * characters wide. "Speak to Ridik" there is ellipsised to "Speak to R…".
 */
const TILE_LABEL = 'ridik_widget_tile_label';

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
 * How far inside the tile anything is drawn.
 *
 * Twelve was the number a face packed to when the tile was a saturated field and
 * the graphic had to fight it. A widget is read at arm's length between other
 * apps' tiles, where the thing that separates a designed one from a generated
 * one is how much of it is empty — Apple's own sit about 18pt in and spend
 * something like 40% of the tile on nothing.
 *
 * Horizontal and vertical differ by two because the axes are not worth the same:
 * width buys air and nothing else, while every dp of height is a dp a row could
 * have stood in, and the rows are the half of these faces that carries words.
 *
 * `RidikRowsFace`'s `*_ABOVE` constants count both of these. Change one without
 * the other and a face draws a row into space another line is standing in.
 */
const PAD_H = 16;
const PAD_V = 14;

/**
 * The ground a cell run is inset from inside its well.
 *
 * The point of a well is that you can see it: the lip is 2dp of it at the top,
 * so anything less than that at the top edge is a track with no top. Rails get
 * two rather than three on the width they cannot spare — thirty-five columns
 * across a phone is already about five dp each.
 */
const WELL_PAD = 3;
const RAIL_WELL_PAD = 2;

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

/**
 * The checklist's slots — the one face that draws more than six.
 *
 * A large tile holds eleven rows at 20dp with its header, and a shopping list is
 * the one thing on a home screen you want all of. Its own table rather than a
 * bigger `ROW_SLOTS_BY_SIZE`, because RemoteViews cannot loop: every slot is
 * written into the XML literally, so raising the shared number would add five
 * permanently hidden views to every agenda, tasks and habits layout for a height
 * only this face offers.
 *
 * Must equal `Slots.listRows` in `RidikCells.kt`. This table decides how many
 * `ridik_row_<n>` views exist; the Kotlin asking for more gets id 0 back and
 * drops those rows in silence.
 */
const LIST_ROW_SLOTS_BY_SIZE = { small: 4, medium: 6, large: 11 };

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
const RAIL_HEIGHT = { small: 18, medium: 16, large: 14 };

/**
 * The ground between two bars on a rail, per size.
 *
 * A grid reads as a field rather than as a block when the ground between its
 * marks is visible, so this is as wide as the width will carry and no wider:
 * seven columns can spend three, twenty-one can spend two, and thirty-five
 * cannot spend anything at all. Five weeks across a phone is about five dp a
 * column before any gap — buying air there would be buying it out of the mark
 * itself, which is rule 1 in reverse.
 */
const RAIL_GAP = { small: 3, medium: 2, large: 1 };

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
const PLATE_GAP = { small: 3, medium: 3, large: 4 };

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
 *
 * The gauge got its presence back on the axis it has spare. Width is spoken for
 * — twenty-four detents already run off the end of a typical medium tile, so a
 * dp of gap costs a cell — but height is free, and a taller detent is a more
 * legible one at arm's length. Which is rule 1 read the way round it is
 * actually useful: buy the readable dimension with the one you have.
 */
const DEBT = {
  small: { cell: 8, height: 20 },
  medium: { cell: 10, height: 24 },
  large: { cell: 10, height: 24 },
};

/** Must equal `ROW_CAP` in `snapshot.ts` and `ROW_SLOTS` in `RidikRowsFace.kt`. */
const ROW_SLOTS = 6;

/**
 * The element's cell height, and the 38% of it a spent cell burns down to.
 *
 * A pair rather than a ratio because RemoteViews cannot set a height: the short
 * view is written into the XML at its final size, and the only way it can be
 * 38% of the tall one is for both numbers to be decided here.
 *
 * `gap` stays at two on medium and large and that is deliberate. Thirty-two
 * cells across a 300dp tile are already about six dp each; a three-dp gap would
 * make the ground wider than half the mark and the strip would stop reading as
 * a day and start reading as a dotted line — and it would swallow the 2dp break
 * before a new booking, which is a *meaning* and not spacing. Eight cells on a
 * small tile have the room, so they take it. What both sizes buy instead is
 * height, which is the axis a strip has spare.
 */
const ELEMENT = {
  small: { height: 36, spent: 14, gap: 3 },
  medium: { height: 32, spent: 12, gap: 2 },
  large: { height: 32, spent: 12, gap: 2 },
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

/** What is left of the narrowest tile in a bucket once the tile's padding is off. */
const contentWidth = (size) => NARROWEST[size] - 2 * PAD_H;

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
    provider: 'ai.dby.ridik.widgets.RidikWidgetProvider',
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
    provider: 'ai.dby.ridik.widgets.RidikAgendaWidgetProvider',
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
    provider: 'ai.dby.ridik.widgets.RidikHabitsWidgetProvider',
    info: 'ridik_rows_habits_info',
    label: 'ridik_rows_habits_label',
    description: 'ridik_rows_habits_description',
    title: 'Ridik — Habits',
    blurb: 'Six rails, three weeks, and whether today is lit.',
    layout: 'ridik_habits',
    // No large. Six rows cannot grow to meet 300dp of height, so the extra buys
    // ground rather than cells — §2 rule 1 exactly. Removed by request after
    // the placed tile was looked at.
    sizes: ['small', 'medium'],
    previewSize: 'medium',
    clocked: [],
    cells: { width: 4, height: 3 },
  },
  {
    kind: 'tasks',
    provider: 'ai.dby.ridik.widgets.RidikTasksWidgetProvider',
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
    provider: 'ai.dby.ridik.widgets.RidikListWidgetProvider',
    info: 'ridik_rows_list_info',
    label: 'ridik_rows_list_label',
    description: 'ridik_rows_list_description',
    title: 'Ridik — List',
    blurb: 'The checklist you still have something open on.',
    layout: 'ridik_list',
    // Large is the one size added after the first release. The provider was
    // always resizable to 800dp and `sizeOf` reads the launcher's own report at
    // draw time, so this only generates the file `layoutFor` was already willing
    // to ask for — no change to the `appwidget-provider`, and every tile already
    // placed keeps working.
    sizes: ['small', 'medium', 'large'],
    // Large, not medium. The picker renders a 3 × 3 card and the medium face
    // draws five rows into it, so the tile a shopper is deciding about was
    // advertised two thirds empty. Eleven rows is what that card actually holds.
    previewSize: 'large',
    clocked: [],
    cells: { width: 3, height: 3 },
  },
  {
    kind: 'people',
    provider: 'ai.dby.ridik.widgets.RidikPeopleWidgetProvider',
    info: 'ridik_rows_people_info',
    label: 'ridik_rows_people_label',
    description: 'ridik_rows_people_description',
    title: 'Ridik — People',
    blurb: 'Promises you owe, oldest first.',
    layout: 'ridik_people',
    // Small and medium only, exactly like Tasks: the face is a strip and a
    // couple of rows, and a large tile would be that with air under it.
    sizes: ['small', 'medium'],
    previewSize: 'medium',
    clocked: ['small', 'medium'],
    cells: { width: 4, height: 2 },
  },
  {
    kind: 'rings',
    provider: 'ai.dby.ridik.widgets.RidikRingsWidgetProvider',
    info: 'ridik_rows_rings_info',
    label: 'ridik_rows_rings_label',
    description: 'ridik_rows_rings_description',
    title: 'Ridik — Rings',
    blurb: 'How much of each habit you have kept, as a share.',
    layout: 'ridik_rings',
    // Medium alone. No small, because two rings is not a set — it reports on a
    // third of somebody's habits and hides the rest without saying so, which is
    // the one thing a tile that is entirely a tally must not do. And no large,
    // because six rings is one 46dp row in a 300dp tile: the face has nothing to
    // spend the height on. Removed by request after the placed tile was seen.
    sizes: ['medium'],
    previewSize: 'medium',
    clocked: [],
    cells: { width: 4, height: 2 },
  },
  {
    kind: 'nownext',
    provider: 'ai.dby.ridik.widgets.RidikNowNextWidgetProvider',
    info: 'ridik_rows_nownext_info',
    label: 'ridik_rows_nownext_label',
    description: 'ridik_rows_nownext_description',
    title: 'Ridik — Now / Next',
    blurb: 'What you are supposed to be doing, in three words.',
    layout: 'ridik_nownext',
    // No small, and deliberately: three columns in 131dp is 40dp each and
    // truncates every title. A one-slot small face is Today's readout already.
    sizes: ['medium', 'large'],
    previewSize: 'medium',
    // The times are drawn from the payload, not counted down, so no clock
    // variant — the face is re-published like every other one.
    clocked: [],
    cells: { width: 4, height: 2 },
  },
  {
    kind: 'focus',
    provider: 'ai.dby.ridik.widgets.RidikFocusWidgetProvider',
    info: 'ridik_rows_focus_info',
    label: 'ridik_rows_focus_label',
    description: 'ridik_rows_focus_description',
    title: 'Ridik — Focus',
    blurb: 'A running session, counted down, with the plan behind it.',
    layout: 'ridik_focus',
    // Small and medium. The face is a clock, a label and a sixteen-cell strip;
    // a large tile is those three things with 200dp of ground under them.
    sizes: ['small', 'medium'],
    previewSize: 'medium',
    // The `Chronometer` formats itself off the elapsed-realtime clock, so the
    // device's 12/24-hour setting never reaches this face.
    clocked: [],
    cells: { width: 4, height: 2 },
  },
  {
    kind: 'horizon',
    provider: 'ai.dby.ridik.widgets.RidikHorizonWidgetProvider',
    info: 'ridik_rows_horizon_info',
    label: 'ridik_rows_horizon_label',
    description: 'ridik_rows_horizon_description',
    title: 'Ridik — Skyline',
    blurb: 'The day as a silhouette: how busy each half hour is, as height.',
    layout: 'ridik_horizon',
    // An *alternative* Today, never a companion to it — a cell here carries a
    // height as well as a level, so the two faces on one screen would disagree
    // about what a cell means.
    //
    // Medium alone: 32 blocks in 131dp is four dp each, narrower than the
    // hairline between two of them, so the silhouette stops being a silhouette
    // and becomes a texture. The mechanic needs the width.
    sizes: ['medium'],
    previewSize: 'medium',
    clocked: [],
    cells: { width: 4, height: 2 },
  },
  {
    kind: 'sundial',
    provider: 'ai.dby.ridik.widgets.RidikSundialWidgetProvider',
    info: 'ridik_rows_sundial_info',
    label: 'ridik_rows_sundial_label',
    description: 'ridik_rows_sundial_description',
    title: 'Ridik — Sundial',
    blurb: 'The day as a sun crossing an arc, and where you are on it.',
    layout: 'ridik_sundial',
    // Medium alone, for Skyline's reason and one more: the disc is sized from
    // the arc's own height, so on a small tile it swallows the dots it is
    // supposed to be riding past.
    sizes: ['medium'],
    previewSize: 'medium',
    clocked: [],
    cells: { width: 4, height: 2 },
  },
  {
    kind: 'route',
    provider: 'ai.dby.ridik.widgets.RidikRouteWidgetProvider',
    info: 'ridik_rows_route_info',
    label: 'ridik_rows_route_label',
    description: 'ridik_rows_route_description',
    title: 'Ridik — Route',
    blurb: 'The day as a journey, with a puck at where you are on it.',
    layout: 'ridik_route',
    // Medium alone. The face *is* a line, and a line in 131dp is 32 segments at
    // four dp each — below the width at which a break between two of them can
    // be seen at all, which is the whole mechanic. A large tile is the same
    // line with 200dp of ground under it.
    sizes: ['medium'],
    previewSize: 'medium',
    clocked: [],
    // **One row.** The face is a line, and a line cannot be made taller without
    // becoming a band — so unlike its four neighbours it cannot fill a two-row
    // tile, and a two-row tile under it was half a tile of ground.
    //
    // `minWidth` has to be raised with it. The launcher derives a preview's
    // column span from `minWidth` when the tile is short, and 240dp over an
    // 89dp column is three — so a 4 × 1 Route was drawn three columns wide while
    // its `ImageView` still asked for a four-column raster, and `fitXY` squashed
    // the puck to seven tenths of its width. It came out an egg.
    cells: { width: 4, height: 1 },
    minWidthDp: 300,
  },
  {
    kind: 'term',
    provider: 'ai.dby.ridik.widgets.RidikTermWidgetProvider',
    info: 'ridik_rows_term_info',
    label: 'ridik_rows_term_label',
    description: 'ridik_rows_term_description',
    title: 'Ridik — Term',
    blurb: 'One dot per day, and how many of them are behind you.',
    layout: 'ridik_term',
    // Small draws the month, medium the year. There is no third period to draw
    // on a large tile — the app models no term or semester, so the honest
    // choice was the two periods a calendar actually has.
    sizes: ['small', 'medium'],
    previewSize: 'medium',
    clocked: [],
    cells: { width: 4, height: 2 },
  },
  {
    kind: 'countdown',
    provider: 'ai.dby.ridik.widgets.RidikCountdownWidgetProvider',
    info: 'ridik_rows_countdown_info',
    label: 'ridik_rows_countdown_label',
    description: 'ridik_rows_countdown_description',
    title: 'Ridik — Countdown',
    blurb: 'How long you have got, counted down by the phone.',
    layout: 'ridik_countdown',
    // Small and medium. The face is one number, one title and one place; a
    // large tile would be 300dp of ground under three lines, which is exactly
    // the air §2 rule 1 forbids buying.
    sizes: ['small', 'medium'],
    previewSize: 'medium',
    // The `Chronometer` is on the elapsed-realtime clock and formats itself, so
    // the device's 12/24-hour setting never reaches it. The header's clock time
    // does — and is set at run time on a view with no fixed lead column, so it
    // needs no second layout either.
    clocked: [],
    cells: { width: 4, height: 2 },
  },
  {
    kind: 'chain',
    provider: 'ai.dby.ridik.widgets.RidikChainWidgetProvider',
    info: 'ridik_rows_chain_info',
    label: 'ridik_rows_chain_label',
    description: 'ridik_rows_chain_description',
    title: 'Ridik — Week',
    blurb: 'Seven days, how full each one is, and which one is today.',
    layout: 'ridik_chain',
    // Small and medium. Seven cells and their dates is a *line*, and a line
    // given 300dp of height is a line with two thirds of a tile under it —
    // §2 rule 1 says extra height buys more cells, and there is no eighth day
    // to buy. Large is folded back to medium in `drawnSize` rather than
    // generated and left as a taller drawing of the same seven things.
    sizes: ['small', 'medium'],
    previewSize: 'medium',
    // No clock on the face at all, so no second lead-column variant.
    clocked: [],
    // Two rows. A letter over a cell over a date is about a hundred and twenty
    // dp, and a one-row tile cut the dates off the bottom — which is exactly the
    // half of the face that says *which* day is the busy one.
    cells: { width: 4, height: 2 },
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
  // 34 minutes out, with a place to be. The preview's `timer` is static text on
  // a `Chronometer` — the picker runs none of our code, so nothing counts down
  // there, and a blank line where the whole face's reading goes would advertise
  // an empty tile.
  countdown: {
    eyebrow: 'NEXT',
    count: '15:00',
    timer: '34:12',
    verb: 'TO GO',
    title: 'Materials lab',
    sub: 'Workshop 2',
  },
  // Three promises, the oldest eleven days old — its own sample and not Tasks',
  // whose rows carry a due time in the lead. A promise has no due time; that is
  // the whole reason the face exists.
  people: {
    eyebrow: 'PEOPLE',
    count: '3 OWED',
    debt: '31',
    footLeft: 'oldest 11d',
    footRight: '3 people',
    rows: [
      { lead: '11d', text: 'The reading list', trail: 'Ana' },
      { lead: '6d', text: 'Send the workshop photos', trail: 'Mira' },
      { lead: '2d', text: 'Lend Sam the torque wrench', trail: 'Sam' },
    ],
  },
  // A 25/5/25/5 pomodoro, six minutes in. `load`/`breaks` are what `buildFocus`
  // emits for that plan, and the timer is static text on a `Chronometer` —
  // nothing counts down in the picker.
  focus: {
    eyebrow: 'FOCUS',
    count: 'RUNNING',
    load: '2222222122222221',
    breaks: '0000000110000001',
    spentThrough: 0,
    timer: '19:04',
    verb: 'OF FOCUS LEFT',
    label: 'Materials revision',
  },
  // A week with a heavy Tuesday, a clear weekend, and today on the Wednesday.
  week: {
    eyebrow: 'THIS WEEK',
    count: '2 CLEAR',
    load: '2310120',
    dates: ['10', '11', '12', '13', '14', '15', '16'],
    todayIndex: 2,
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
 *
 * **The count is the face's hero number.** Four of the five faces have exactly
 * one figure worth reading across a room — 4/6, 2 LATE, 4 OF 12, THU 13 — and
 * it was set at the eyebrow's own ten points, which made every tile a row of
 * small tracked capitals with a graphic under it and nothing to look at first.
 * At fifteen it is the thing the eye lands on and the label beside it is a
 * label. Today is the exception and keeps its readout, which is bigger still.
 *
 * The tracking comes off as the size goes on: 0.12 of an em is engraving on a
 * ten-point label and looseness on a fifteen-point number.
 *
 * Small takes twelve and a box cut to what "4 OF 12" actually measures, because
 * there the label and the number are competing for about a hundred dp and the
 * box is what the eyebrow loses whether or not the number fills it. Fifty-four
 * is a bigger figure than the ten-point one it replaces *and* seventeen dp back
 * for the name beside it — the old box was seventy for a number that never
 * needed more than fifty.
 */
const COUNT = {
  small: { size: 12, width: 54 },
  medium: { size: 15, width: 78 },
  large: { size: 15, width: 78 },
};

function header(depth, { ember, eyebrow, count, size = 'medium' } = {}) {
  const pad = indent(depth + 4);
  const figure = COUNT[size];
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
${indent(depth + 6)}android:layout_width="${figure.width}dp"
${indent(depth + 6)}android:layout_height="wrap_content"
${indent(depth + 6)}android:layout_marginStart="8dp"
${indent(depth + 6)}android:fontFamily="monospace"
${indent(depth + 6)}android:gravity="end"
${indent(depth + 6)}android:includeFontPadding="false"
${indent(depth + 6)}android:letterSpacing="0.02"
${indent(depth + 6)}android:maxLines="1"
${indent(depth + 6)}android:paddingEnd="2dp"
${indent(depth + 6)}android:paddingStart="2dp"${text(depth + 6, count)}
${indent(depth + 6)}android:textAllCaps="true"
${indent(depth + 6)}android:textColor="@color/${accentColour(ember)}"
${indent(depth + 6)}android:textSize="${figure.size}sp"${attr(depth + 6, 'visibility', count ? null : 'gone')} />
${size === 'small' ? '' : `\n${mic(depth + 2, { ember })}\n`}${indent(depth)}</LinearLayout>`;
}

/**
 * The microphone, at the trailing edge of the header.
 *
 * Every entry point this family has ever had opens a screen you *read*, and the
 * thing they are all sitting next to on the home screen is an app whose entire
 * purpose is capture. This is the one tap on a tile that starts a sentence
 * instead of ending one, and it is the reason the widgets are worth their own
 * process at all.
 *
 * **Not on small.** Not for want of dp — a small tile has room for 18 of them —
 * but because iOS gives a `.systemSmall` widget exactly one tap target and it is
 * the whole tile. A mic drawn there would open the reading screen on one
 * platform and the microphone on the other, which is the "two different
 * products" failure AGENTS.md is about. The rule is stated once, here and in
 * `SpeakAffordance` in `RidikElements.swift`, and both say no.
 *
 * `android:tint` rather than a per-ember drawable: the ember tints it, the
 * layouts are already generated per ember, and the launcher resolves the colour
 * reference in its own process — which is the whole reason nothing in this file
 * computes a colour. One vector, fifty-three layouts, no night-mode seam.
 */
function mic(depth, { ember }) {
  const pad = indent(depth + 4);
  return `${indent(depth)}<ImageView
${pad}android:id="@+id/${IDS.mic}"
${pad}android:layout_width="26dp"
${pad}android:layout_height="18dp"
${pad}android:layout_marginStart="6dp"
${pad}android:contentDescription="@string/${MIC_LABEL}"
${pad}android:layout_gravity="center_vertical"
${pad}android:paddingStart="8dp"
${pad}android:scaleType="fitCenter"
${pad}android:src="@drawable/${MIC_DRAWABLE}"
${pad}android:tint="@color/${accentColour(ember)}" />`;
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
${pad}android:layout_marginTop="10dp"
${pad}android:ellipsize="end"
${pad}android:maxLines="2"
${pad}android:textColor="@color/ridik_widget_ink"
${pad}android:textSize="15sp"
${pad}android:visibility="gone" />

${indent(depth)}<TextView
${pad}android:id="@+id/${IDS.sub}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginTop="3dp"
${pad}android:ellipsize="end"
${pad}android:maxLines="2"
${pad}android:textColor="@color/ridik_widget_ink_soft"
${pad}android:textSize="12sp"
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
 *
 * The row of cells sits in a **well** and the ruler underneath does not. The
 * well is the track the day runs in, so it has to be the full width of the day
 * whether or not anything is booked in it — which is also what gives an empty
 * strip something to be empty *inside of*. Putting it around the ruler as well
 * would have made it a panel, and a panel is a box drawn round some content
 * rather than a recess the content sits in.
 */
function element(depth, { ember, size, sample, slots: override, ruler = true }) {
  // The Focus face draws its own sixteen — a session is minutes to an hour or
  // two, and 32 cells of a 25-minute pomodoro is 47 seconds each, below the
  // resolution at which a boundary between two of them means anything.
  const slots = override ?? DAY_SLOTS[size];
  const { height, spent: spentHeight, gap } = ELEMENT[size];
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
      i === slots - 1 ? '' : `\n${pad}android:layout_marginEnd="${gap}dp"`
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
${indent(depth + 4)}android:layout_marginTop="10dp"
${indent(depth + 4)}android:orientation="vertical">

${indent(depth + 2)}<LinearLayout
${indent(depth + 6)}android:layout_width="match_parent"
${indent(depth + 6)}android:layout_height="wrap_content"
${indent(depth + 6)}android:background="@drawable/${WELL}"
${indent(depth + 6)}android:orientation="horizontal"
${indent(depth + 6)}android:padding="${WELL_PAD}dp">

${cells.join('\n\n')}
${indent(depth + 2)}</LinearLayout>${ruler ? `\n\n${axis(depth + 2)}` : ''}
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
${indent(depth + 4)}android:layout_marginTop="5dp"
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
 * The six weeks sit in a **well** and the letters over them do not. The letters
 * name the columns and the plate is what is being read, so a recess round both
 * would be a box drawn about a heading — and the day cells would no longer be
 * the thing sitting *in* something. The well is what stops a 42-cell grid from
 * reading as one block: it gives the ground between the cells an edge to be
 * ground against.
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
${pad}android:textSize="10sp" />`;
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
${pad}android:textSize="${numerals ? '14sp' : '1sp'}"${attr(
        depth + 6,
        'visibility',
        hidden ? 'invisible' : null,
      )} />`);
    }

    weeks.push(`${indent(depth + 4)}<LinearLayout
${indent(depth + 8)}android:id="@+id/${IDS.plateWeek(week)}"
${indent(depth + 8)}android:layout_width="match_parent"
${indent(depth + 8)}android:layout_height="0dp"${
      week === 0 ? '' : `\n${indent(depth + 8)}android:layout_marginTop="${gap}dp"`
    }
${indent(depth + 8)}android:layout_weight="1"
${indent(depth + 8)}android:gravity="center_vertical"
${indent(depth + 8)}android:orientation="horizontal">

${days.join('\n\n')}
${indent(depth + 4)}</LinearLayout>`);
  }

  return `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:id="@+id/${IDS.plateArea}"
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="0dp"
${indent(depth + 4)}android:layout_marginTop="8dp"
${indent(depth + 4)}android:layout_weight="${size === 'large' ? PLATE_WEIGHT : 1}"
${indent(depth + 4)}android:orientation="vertical">

${indent(depth + 2)}<LinearLayout
${indent(depth + 6)}android:layout_width="match_parent"
${indent(depth + 6)}android:layout_height="wrap_content"
${indent(depth + 6)}android:layout_marginBottom="4dp"
${indent(depth + 6)}android:orientation="horizontal">

${heads.join('\n\n')}
${indent(depth + 2)}</LinearLayout>

${indent(depth + 2)}<LinearLayout
${indent(depth + 6)}android:layout_width="match_parent"
${indent(depth + 6)}android:layout_height="0dp"
${indent(depth + 6)}android:layout_weight="1"
${indent(depth + 6)}android:background="@drawable/${WELL}"
${indent(depth + 6)}android:orientation="vertical"
${indent(depth + 6)}android:padding="${WELL_PAD}dp">

${weeks.join('\n\n')}
${indent(depth + 2)}</LinearLayout>
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
 *
 * **Each rail gets its own well, and it stops at the gutter.** Six of them
 * stacked is what turns a solid block of two hundred marks into six tracks with
 * ground between them, which is the whole difference between a board and a
 * grid — and a single well around all six would have been the block again with
 * a line drawn round it. The gutter stays outside because a name is not data.
 */
function rails(depth, { ember, size, sample }) {
  const days = RAIL_DAYS[size];
  const gap = RAIL_GAP[size];
  const ideal = GUTTER[size];
  // Content width is the tile less the root padding on both sides.
  const room = contentWidth(size) * GUTTER_SHARE;
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
        cell(depth + 6, {
          id: IDS.railCell(rail, day),
          ember,
          level,
          width: '0dp',
          height: `${RAIL_HEIGHT[size]}dp`,
          weight: '1',
          marginEnd: day === days - 1 ? null : `${gap}dp`,
        }),
      );
    }

    const pad = indent(depth + 6);
    rows.push(`${indent(depth + 2)}<LinearLayout
${pad}android:id="@+id/${IDS.rail(rail)}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="0dp"
${pad}android:layout_marginTop="3dp"
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

${indent(depth + 4)}<LinearLayout
${indent(depth + 8)}android:layout_width="0dp"
${indent(depth + 8)}android:layout_height="wrap_content"
${indent(depth + 8)}android:layout_weight="1"
${indent(depth + 8)}android:background="@drawable/${WELL}"
${indent(depth + 8)}android:orientation="horizontal"
${indent(depth + 8)}android:paddingBottom="${RAIL_WELL_PAD}dp"
${indent(depth + 8)}android:paddingEnd="${RAIL_WELL_PAD}dp"
${indent(depth + 8)}android:paddingStart="${RAIL_WELL_PAD}dp"
${indent(depth + 8)}android:paddingTop="${RAIL_WELL_PAD + 1}dp">

${bars.join('\n\n')}
${indent(depth + 4)}</LinearLayout>
${indent(depth + 2)}</LinearLayout>`);
  }

  // The weekday ruler is set at draw time, because a window that ends on today
  // rotates its columns every midnight — a static M-to-S header would be right
  // one day in seven. Large has no ruler at all: 35 columns inside a phone
  // widget is about 5dp each, and a letter does not fit in 5dp.
  // The letters ride in a box padded exactly like the well under them, or every
  // column would be a couple of dp out of register with the bar it names — the
  // one misalignment this face cannot afford, because reading *down* a column
  // is the whole reason the board is drawn as a board.
  //
  // They are also sized by how many there are, which is the same trade the rail
  // gap makes: seven columns across a small tile have fifteen dp each and can
  // carry a ten-point letter with air round it, twenty-one have five and cannot
  // — at nine points the row of them closes into a grey bar with no gaps, which
  // is a ruler you cannot count along.
  const ruler = days > 21 ? '' : `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="wrap_content"
${indent(depth + 4)}android:layout_marginTop="8dp"
${indent(depth + 4)}android:orientation="horizontal">

${indent(depth + 2)}<ImageView
${indent(depth + 6)}android:layout_width="${wide}dp"
${indent(depth + 6)}android:layout_height="1dp"
${indent(depth + 6)}android:importantForAccessibility="no" />

${indent(depth + 2)}<LinearLayout
${indent(depth + 6)}android:layout_width="0dp"
${indent(depth + 6)}android:layout_height="wrap_content"
${indent(depth + 6)}android:layout_weight="1"
${indent(depth + 6)}android:orientation="horizontal"
${indent(depth + 6)}android:paddingEnd="${RAIL_WELL_PAD}dp"
${indent(depth + 6)}android:paddingStart="${RAIL_WELL_PAD}dp">

${Array.from({ length: days }, (_, day) => {
    const pad = indent(depth + 8);
    return `${indent(depth + 4)}<TextView
${pad}android:id="@+id/${IDS.wday(day)}"
${pad}android:layout_width="0dp"
${pad}android:layout_height="wrap_content"
${pad}android:layout_weight="1"${day === days - 1 ? '' : `\n${pad}android:layout_marginEnd="${gap}dp"`}
${pad}android:fontFamily="monospace"
${pad}android:gravity="center"
${pad}android:includeFontPadding="false"
${pad}android:maxLines="1"${text(depth + 8, sample ? WEEKDAYS[day % 7] : null)}
${pad}android:textColor="@color/ridik_widget_ink_soft"
${pad}android:textSize="${days > 7 ? 8 : 10}sp" />`;
  }).join('\n\n')}
${indent(depth + 2)}</LinearLayout>
${indent(depth)}</LinearLayout>

`;

  return `${ruler}${indent(depth)}<LinearLayout
${indent(depth + 4)}android:id="@+id/${IDS.railArea}"
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="0dp"
${indent(depth + 4)}android:layout_marginTop="4dp"
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
 *
 * The well runs the **whole** width, spacer and all. A gauge's track exists
 * whether or not there is anything in it, and the cold tail of an easy week is
 * the part worth being able to see: twelve detents in an empty track is a
 * reading, twelve detents on bare ground is a row of dots.
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
${indent(depth + 4)}android:layout_height="${height + 2 * WELL_PAD}dp"
${indent(depth + 4)}android:layout_marginTop="10dp"
${indent(depth + 4)}android:background="@drawable/${WELL}"
${indent(depth + 4)}android:orientation="horizontal"
${indent(depth + 4)}android:padding="${WELL_PAD}dp">

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
${indent(depth + 4)}android:layout_marginTop="6dp"
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
${pad}android:textSize="12sp" />

${indent(depth + 2)}<TextView
${pad}android:id="@+id/${IDS.footRight}"
${pad}android:layout_width="wrap_content"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginStart="6dp"
${pad}android:maxLines="1"${text(pad.length, sample ? sample.footRight : null)}
${pad}android:textColor="@color/ridik_widget_ink_soft"
${pad}android:textSize="12sp" />
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
${pad}android:layout_height="wrap_content"${index === 0 ? '' : `\n${pad}android:layout_marginTop="7dp"`}
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
${indent(depth + 8)}android:textSize="12sp" />

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
${indent(depth + 8)}android:textSize="10sp"${attr(
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
${indent(depth + 4)}android:layout_marginTop="10dp"${fill ? `\n${indent(depth + 4)}android:layout_weight="1"` : ''}
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
${pad}android:layout_height="wrap_content"${index === 0 ? '' : `\n${pad}android:layout_marginTop="9dp"`}
${pad}android:gravity="center_vertical"
${pad}android:orientation="horizontal"${attr(pad.length, 'visibility', row ? null : 'gone')}>

${cell(depth + 4, {
      id: IDS.tick(index),
      ember,
      level: row && row.done ? 2 : 0,
      width: '8dp',
      height: '8dp',
      marginStart: '2dp',
      marginEnd: '11dp',
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
${indent(depth + 4)}android:layout_marginTop="12dp"${fill ? `\n${indent(depth + 4)}android:layout_weight="1"` : ''}
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
${inner}android:textSize="${stacked ? '38' : '32'}sp" />`;

  const title = `${indent(at)}<TextView
${inner}android:id="@+id/${IDS.nextTitle}"
${inner}android:layout_width="${stacked ? 'match_parent' : '0dp'}"
${inner}android:layout_height="wrap_content"
${inner}android:layout_margin${stacked ? 'Top="3dp"' : 'Start="10dp"'}${
    stacked ? '' : `\n${inner}android:layout_weight="1"`
  }
${inner}android:ellipsize="end"
${inner}android:includeFontPadding="false"
${inner}android:maxLines="${stacked ? 2 : 1}"${text(at + 4, sample ? sample.title : null)}
${inner}android:textColor="@color/ridik_widget_ink"
${inner}android:textSize="15sp" />`;

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
${indent(depth + 4)}android:layout_marginTop="10dp"
${indent(depth + 4)}android:orientation="vertical">

${head}

${indent(depth + 2)}<Chronometer
${pad}android:id="@+id/${IDS.timer}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginTop="4dp"
${pad}android:ellipsize="end"
${pad}android:includeFontPadding="false"
${pad}android:maxLines="1"
${pad}android:textColor="@color/${accentColour(ember)}"
${pad}android:textSize="12sp"
${pad}android:visibility="gone" />

${indent(depth + 2)}<TextView
${pad}android:id="@+id/${IDS.nextSub}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginTop="4dp"
${pad}android:ellipsize="end"
${pad}android:maxLines="1"${text(pad.length, sample ? sample.sub : null)}
${pad}android:textColor="@color/${accentColour(ember)}"
${pad}android:textSize="12sp"${attr(pad.length, 'visibility', sample ? null : 'gone')} />
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
${pad}android:layout_marginTop="8dp"
${pad}android:ellipsize="end"
${pad}android:maxLines="1"${text(pad.length, sample ? sample.allDay : null)}
${pad}android:textColor="@color/ridik_widget_ink"
${pad}android:textSize="13sp"${attr(
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
    android:background="@drawable/${groundDrawable(ember)}"
    android:paddingBottom="${PAD_V}dp"
    android:paddingEnd="${PAD_H}dp"
    android:paddingStart="${PAD_H}dp"
    android:paddingTop="${PAD_V}dp">

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
${pad}android:layout_marginTop="8dp"
${pad}android:ellipsize="end"
${pad}android:maxLines="2"
${pad}android:text="Nothing published yet."
${pad}android:textColor="@color/ridik_widget_ink"
${pad}android:textSize="17sp" />

    <TextView
${pad}android:id="@+id/${IDS.noticeBody}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginTop="4dp"
${pad}android:ellipsize="end"
${pad}android:maxLines="3"
${pad}android:text="Open Ridik once and today lands here."
${pad}android:textColor="@color/ridik_widget_ink_soft"
${pad}android:textSize="13sp" />
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
    header(4, sample ? { ember, size, eyebrow: sample.eyebrow, count: sample.count } : { ember, size }),
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
    header(4, sample ? { ember, size, eyebrow: sample.eyebrow, count: sample.count } : { ember, size }),
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
    header(4, sample ? { ember, size, eyebrow: sample.eyebrow, count: sample.count } : { ember, size }),
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
    header(4, sample ? { ember, size, eyebrow: sample.eyebrow, count: sample.count } : { ember, size }),
    debt(4, { ember, size, sample }),
    footer(4, { sample }),
    slack(4),
    copy(4),
    rows(4, { ember, slots: ROW_SLOTS_BY_SIZE[size], leadWidth, sample, fill: false }),
  ];
  return face({ ember, body: parts.join('\n\n'), preview });
}

/**
 * Now / Next / Later — the one face that answers instead of drawing.
 *
 * Every other face is an instrument: it draws a quantity and lets you read it.
 * None of them answers the plainest question anyone asks a home screen, which is
 * "what am I supposed to be doing?" Three slots do, in three words.
 *
 * The primitive still appears — a 6dp bar per slot — so the tile belongs to the
 * family rather than being a card of text that happens to share a background.
 * That bar is the only graphic here, and it is deliberately not a strip: a strip
 * would re-answer "how is my day shaped", which is Today's question.
 *
 * **One hot per tile, and on large the strip takes it.** Medium gives `hot` to
 * the NOW slot because it is the only claim on the tile. Large draws the day
 * element underneath, and §1.1 allows exactly one hot object — so the slots step
 * down to 2 / 1 / 0 and the strip keeps the ember, exactly as §3.2 gives it to
 * the element rather than to the plate.
 *
 * Columns, not rows, and that is why there is no small: three columns in 131dp
 * is 40dp each and truncates every title (§2 rule 2). A one-slot small face
 * would be Today's readout with a different word over it.
 */
function slots(depth, { ember, big, sample }) {
  const labels = ['NOW', 'NEXT', 'LATER'];
  const columns = labels.map((label, index) => {
    const row = sample && sample.rows && sample.rows[index] ? sample.rows[index] : null;
    // Medium: the NOW slot is the tile's one hot object. Large: the strip is,
    // so these step down and none of them competes with it.
    const level = big ? Math.max(0, 2 - index) : index === 0 ? 3 : Math.max(0, 2 - index);
    const pad = indent(depth + 6);
    return `${indent(depth + 2)}<LinearLayout
${pad}android:layout_width="0dp"
${pad}android:layout_height="wrap_content"
${pad}android:layout_weight="1"${index === 0 ? '' : `\n${pad}android:layout_marginStart="12dp"`}
${pad}android:orientation="vertical">

${indent(depth + 4)}<TextView
${indent(depth + 8)}android:id="@+id/${IDS.slotLabel(index)}"
${indent(depth + 8)}android:layout_width="match_parent"
${indent(depth + 8)}android:layout_height="wrap_content"
${indent(depth + 8)}android:fontFamily="monospace"
${indent(depth + 8)}android:includeFontPadding="false"
${indent(depth + 8)}android:letterSpacing="0.14"
${indent(depth + 8)}android:maxLines="1"
${indent(depth + 8)}android:text="${label}"
${indent(depth + 8)}android:textColor="@color/ridik_widget_ink_soft"
${indent(depth + 8)}android:textSize="9sp" />

${cell(depth + 4, {
      id: IDS.slotBar(index),
      ember,
      level,
      width: 'match_parent',
      height: '6dp',
      marginStart: null,
      marginEnd: null,
    }).replace(/^/, '')}

${indent(depth + 4)}<TextView
${indent(depth + 8)}android:id="@+id/${IDS.slotTime(index)}"
${indent(depth + 8)}android:layout_width="match_parent"
${indent(depth + 8)}android:layout_height="wrap_content"
${indent(depth + 8)}android:layout_marginTop="5dp"
${indent(depth + 8)}android:ellipsize="end"
${indent(depth + 8)}android:fontFamily="monospace"
${indent(depth + 8)}android:includeFontPadding="false"
${indent(depth + 8)}android:maxLines="1"${text(depth + 8, row ? row.lead : null)}
${indent(depth + 8)}android:textColor="@color/${accentColour(ember)}"
${indent(depth + 8)}android:textSize="12sp" />

${indent(depth + 4)}<TextView
${indent(depth + 8)}android:id="@+id/${IDS.slotTitle(index)}"
${indent(depth + 8)}android:layout_width="match_parent"
${indent(depth + 8)}android:layout_height="wrap_content"
${indent(depth + 8)}android:layout_marginTop="1dp"
${indent(depth + 8)}android:ellipsize="end"
${indent(depth + 8)}android:includeFontPadding="false"
${indent(depth + 8)}android:lineSpacingMultiplier="1.15"
${indent(depth + 8)}android:maxLines="2"${text(depth + 8, row ? row.text : null)}
${indent(depth + 8)}android:textColor="@color/ridik_widget_ink"
${indent(depth + 8)}android:textSize="13sp" />
${indent(depth + 2)}</LinearLayout>`;
  });

  return `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:id="@+id/${IDS.slotArea}"
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="wrap_content"
${indent(depth + 4)}android:layout_marginTop="8dp"
${indent(depth + 4)}android:baselineAligned="false"
${indent(depth + 4)}android:orientation="horizontal">

${columns.join('\n\n')}
${indent(depth)}</LinearLayout>`;
}

/**
 * The completion rings — the one face in the family that draws a proportion.
 *
 * §1 bans progress rings across the family and that ban is not vacated by this
 * face; it is *narrowed*, and the narrowing is written down in §1 rather than
 * left implicit in the code. The argument for a tile is genuinely weaker than
 * for the app screen the pattern came from — a ring read from across a room is a
 * smear where four discrete levels are not — so this exists as a face the user
 * chooses, never as a replacement for the Habits rails beside it.
 *
 * Every ring is an `ImageView` the Kotlin fills with a bitmap, because
 * RemoteViews cannot draw an arc. It is tinted here rather than coloured there:
 * see `RidikRings.kt` for why a colour computed in the provider is computed in
 * the wrong process, and why the bitmap is a white mask.
 */
/**
 * People — the debt primitive, pointed at promises.
 *
 * Tasks' age axis transfers unchanged: one cell per outstanding promise, oldest
 * left, the single oldest hot. Nothing new is invented, which is why this is the
 * cheapest new face in the family.
 *
 * The reason to have it is that it is the only face whose data nothing else in
 * the app surfaces at a glance. A promise with no due date never becomes
 * overdue, so it never appears on Tasks and never appears in a briefing — it
 * just gets older. This is the app's quietest failure, and a strip is the fix.
 */
function peopleFace({ ember, size, preview }) {
  const sample = preview ? SAMPLE.people : null;
  const parts = [
    header(4, sample ? { ember, size, eyebrow: sample.eyebrow, count: sample.count } : { ember, size }),
    debt(4, { ember, size, sample }),
    // A footer, never `axis()`. The ruler under the day strip reads 07 … 23
    // because that strip is hours; this strip is *ages*, and an hour ruler under
    // it was labelling days since a promise was made with times of day.
    footer(4, { sample }),
    slack(4),
    rows(4, {
      ember,
      slots: ROW_SLOTS_BY_SIZE[size],
      leadWidth: LEAD.narrow,
      sample,
      fill: false,
    }),
    copy(4),
  ];
  return face({ ember, body: parts.join('\n\n'), preview });
}

/**
 * The live clock, and a plain `TextView` standing in for it in the picker.
 *
 * A `Chronometer` **ignores `android:text`**: it formats its own elapsed time on
 * inflation, so a preview layout carrying one drew a confident `00:00` — the
 * face whose entire content is a number, advertising itself as broken. Nothing
 * sets it in the picker, because nothing of ours runs there, so the preview
 * emits a `TextView` with the sample time in it instead. The live layouts keep
 * the `Chronometer`; `countdown()` is what drives it.
 */
function timerNote(depth, { sample }) {
  const pad = indent(depth + 4);
  return `${indent(depth)}<TextView
${pad}android:id="@+id/${IDS.timerNote}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:ellipsize="end"
${pad}android:fontFamily="monospace"
${pad}android:includeFontPadding="false"
${pad}android:letterSpacing="0.08"
${pad}android:maxLines="1"${text(depth + 4, sample)}
${pad}android:textColor="@color/ridik_widget_ink_soft"
${pad}android:textSize="10sp" />`;
}

function timerView(depth, { ember, preview, sample, size, big }) {
  const tag = preview ? 'TextView' : 'Chronometer';
  const pad = indent(depth + 4);
  return `${indent(depth)}<${tag}
${pad}android:id="@+id/${IDS.timer}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginTop="8dp"
${pad}android:ellipsize="end"
${pad}android:fontFamily="monospace"
${pad}android:includeFontPadding="false"
${pad}android:maxLines="1"${text(depth + 4, sample)}
${pad}android:textColor="@color/${accentColour(ember)}"
${pad}android:textSize="${big}sp"${attr(depth + 4, 'visibility', sample ? null : 'gone')} />`;
}

/**
 * The countdown — the one face that is still moving when nothing is publishing.
 *
 * `Chronometer` with `setChronometerCountDown(true)` is the only genuinely live
 * element Android gives a widget for zero wakeups. Today already uses it for the
 * travel buffer; this face is that element promoted to the whole tile and
 * pointed at the *start* as well, because most things on a calendar have no
 * buffer to leave for and the question "how long have I got" is asked of them
 * just the same.
 *
 * The verb rides in the `Chronometer`'s own format string rather than in a
 * label beside it — a live view next to a static one re-measures the row every
 * second and the two disagree about their baseline for one frame each time.
 * That is also why the place is on its own line here and not in the format: at
 * this size the format string is the tile's hero and a location in it would
 * push the digits out of the reading.
 */
function countdownFace({ ember, size, preview }) {
  const sample = preview ? SAMPLE.countdown : null;
  const pad = indent(8);
  const timer = timerView(4, {
    ember,
    preview,
    sample: sample ? sample.timer : null,
    size,
    // The digits *are* the face, so they are sized like it. At 34 they were a
    // reading with half a tile of ground under them; at 52 they are the object
    // the tile is for and the title underneath is a label on it.
    big: size === 'small' ? 40 : 52,
  });

  const title = `${indent(4)}<TextView
${pad}android:id="@+id/${IDS.nextTitle}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginTop="6dp"
${pad}android:ellipsize="end"
${pad}android:includeFontPadding="false"
${pad}android:maxLines="${size === 'small' ? 2 : 1}"${text(8, sample ? sample.title : null)}
${pad}android:textColor="@color/ridik_widget_ink"
${pad}android:textSize="${size === 'small' ? 15 : 17}sp" />`;

  const sub = `${indent(4)}<TextView
${pad}android:id="@+id/${IDS.nextSub}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginTop="3dp"
${pad}android:ellipsize="end"
${pad}android:includeFontPadding="false"
${pad}android:maxLines="1"${text(8, sample ? sample.sub : null)}
${pad}android:textColor="@color/ridik_widget_ink_soft"
${pad}android:textSize="12sp" />`;

  // The slack sits *between* the reading and the label, not under both: the
  // digits are the tile's one object and belong at the top, and the thing they
  // are counting towards belongs on the floor where the eye lands last. Under
  // both, a two-row tile was three lines and a hand's width of empty ground.
  const body = [
    header(4, sample ? { ember, size, eyebrow: sample.eyebrow, count: sample.count } : { ember, size }),
    timer,
    timerNote(4, { sample: sample ? sample.verb : null }),
    slack(4),
    title,
    sub,
    copy(4),
  ].join('\n\n');
  return face({ ember, body, preview });
}

/**
 * Focus — the one face with a live clock over something that has a natural end.
 *
 * A running session is the only thing in the app that deserves a `Chronometer`
 * more than "leave in 34 min" does: a day has no end to count towards, and a
 * 40-minute session ends in 40 minutes by construction.
 *
 * The strip is the same generator every other day-shaped face uses, at sixteen
 * slots instead of thirty-two — so a phase boundary is the same 2pt hairline the
 * day strip draws, made by the same code.
 */
function focusFace({ ember, size, preview }) {
  const sample = preview ? SAMPLE.focus : null;
  const pad = indent(8);
  const timer = timerView(4, {
    ember,
    preview,
    sample: sample ? sample.timer : null,
    size,
    // A step smaller than Countdown's: the session strip is under this one, so
    // the tile has a second object and the digits do not have to carry it alone.
    big: size === 'small' ? 34 : 44,
  });

  const label = `${indent(4)}<TextView
${pad}android:id="@+id/${IDS.nextTitle}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:layout_marginTop="4dp"
${pad}android:ellipsize="end"
${pad}android:includeFontPadding="false"
${pad}android:maxLines="1"${text(8, sample ? sample.label : null)}
${pad}android:textColor="@color/ridik_widget_ink"
${pad}android:textSize="${size === 'small' ? 13 : 15}sp" />`;

  const body = [
    header(4, sample ? { ember, size, eyebrow: sample.eyebrow, count: sample.count } : { ember, size }),
    timer,
    timerNote(4, { sample: sample ? sample.verb : null }),
    label,
    slack(4),
    // No ruler. `axis()` labels the five quarters of the *waking window* — 07,
    // 11, 15, 19, 23 — and this strip is a forty-minute session. An hour ruler
    // under it is a label from a different measurement, which is the same
    // mistake the People face was making with the same generator.
    element(4, { ember, size, sample, slots: FOCUS_SLOTS, ruler: false }),
    copy(4),
  ].join('\n\n');
  return face({ ember, body, preview });
}

/** Must equal `FOCUS_CELLS` in `snapshot.ts` and `WidgetSnapshot.FOCUS_CELLS`. */
const FOCUS_SLOTS = 16;

/* ------------------------------------------------- the four rastered faces */

/**
 * The height the bitmap is given, per face and per size.
 *
 * A fixed dp on the `ImageView` rather than a weight: `RemoteViews` cannot read
 * a measured height back, so the Kotlin has to know how tall the raster should
 * be before it draws one, and the only way for the two to agree is a constant
 * they both state. `PLOT_HEIGHT` in `RidikRowsFace.kt` is the other end.
 */
/**
 * **The graphic fills its tile.** A two-row Android tile is about 205dp, of
 * which the frame, the header and the caption take 77 — so the box is 128 and
 * every one of these takes it.
 *
 * These used to be the iOS heights scaled to the Android width, which left a
 * third of the tile as ground under a small drawing: correct in shape and cheap
 * to look at. What made *that* necessary in the first place was the sun and the
 * puck being sized from the height alone, so a taller box inflated them into
 * blots. They are clamped against the horizontal step now — `RidikPlots` and
 * `sundialGeometry` — so the box is free to grow and the ornaments on it are not.
 *
 * Route is the exception and is a *line*: it cannot be made taller without
 * becoming a band, so its tile is one row rather than two. See its `cells`.
 *
 * Its 44 was 30, which was too short twice over. The line is 27% of the box, so
 * 30 drew an eight-dp hairline; and the 50-odd dp a medium tile had left over
 * all went into one hole between the line and its caption. It is centred in the
 * slack now rather than pushed off it — `PlotScaffold` on the iOS side.
 */
const PLOT_HEIGHT = {
  horizon: { medium: 128 },
  sundial: { medium: 128 },
  route: { medium: 44 },
  term: { small: 104, medium: 128 },
};

/**
 * The face's one `ImageView`, plus the line under it that says what it shows.
 *
 * `android:tint` is a colour *reference*, so the launcher resolves it against
 * its own light/dark — which is the entire reason these four can be rastered at
 * all. Nothing about the bitmap is a colour; see `RidikPlots.kt`.
 */
function plot(depth, { ember, kind, size, preview, note }) {
  const pad = indent(depth + 4);
  const height = PLOT_HEIGHT[kind][size];
  // The slack is *between* the graphic and its caption. The graphic is drawn at
  // a fixed aspect and must not grow into the tile — everything on it is sized
  // from its own box — so the height a two-row Android tile has spare goes under
  // it, and the caption sits on the floor where the eye lands last.
  return `${indent(depth)}<ImageView
${pad}android:id="@+id/${IDS.plot}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="${height}dp"
${pad}android:layout_marginTop="10dp"
${pad}android:importantForAccessibility="no"
${pad}android:scaleType="fitXY"${preview ? `\n${pad}android:src="@drawable/ridik_preview_${kind}"` : ''}
${pad}android:tint="@color/${accentColour(ember)}" />

${slack(depth)}

${indent(depth)}<TextView
${pad}android:id="@+id/${IDS.plotNote}"
${pad}android:layout_width="match_parent"
${pad}android:layout_height="wrap_content"
${pad}android:ellipsize="end"
${pad}android:includeFontPadding="false"
${pad}android:maxLines="1"${text(depth + 4, note)}
${pad}android:textColor="@color/ridik_widget_ink_soft"
${pad}android:textSize="11sp" />`;
}

function plotFace({ ember, kind, size, preview, eyebrow, count, note }) {
  const body = [
    header(4, preview ? { ember, size, eyebrow, count } : { ember, size }),
    plot(4, { ember, kind, size, preview, note: preview ? note : null }),
    copy(4),
  ].join('\n\n');
  return face({ ember, body, preview });
}

/* ------------------------------------------------------- the preview rasters */

/**
 * The picker runs none of our code, so a rastered face would show an empty box
 * there — and "the widgets look blank" is judged in the gallery, before a tile
 * is ever placed.
 *
 * The answer is a **vector** drawable per face, generated here from the same
 * geometry the Kotlin rasters at run time. A vector is a build-time file the
 * launcher inflates like any other resource, it carries `android:fillAlpha` so
 * the four levels survive, and it is tinted by the same `android:tint` — so the
 * preview and the live tile are the same drawing made twice, rather than a
 * hand-drawn impression of one.
 *
 * ## The viewport has to be the shape of the box it lands in
 *
 * `scaleType="fitXY"` scales a drawable to the view **without preserving its
 * aspect**. A single 300 × 100 viewport for all four therefore stretched every
 * one of them by a different amount in each axis — and on Route, a 300 × 100
 * vector landing in a 208 × 26 view made the puck three and a half times wider
 * than it was tall. It drew as a great ember blot lying across the line, which
 * is exactly what the picker was showing.
 *
 * So each preview gets its own viewport, in **dp**, equal to the box it will be
 * drawn into: the tile's content width at its declared cell count, by the
 * `ImageView`'s own fixed height. Any residual stretch is then the difference
 * between the launcher's cell and `minWidth`, which is a few percent rather
 * than a factor of three.
 */
function plotViewport(kind, widget) {
  return {
    width: widget.cells.width * PREVIEW_CELL_DP - PAD_H * 2,
    height: PLOT_HEIGHT[kind][widget.previewSize],
  };
}


/**
 * How wide one grid cell is when the *picker* draws a preview.
 *
 * Not `minWidth`'s 60dp, which is the smallest a tile may be squeezed to and not
 * the size anything is ever drawn at. Measured instead: a four-cell preview on a
 * 411dp phone renders 356dp wide, which is 89 a cell.
 *
 * It only has to be close. What it replaces was a single 300 × 100 viewport for
 * every face, which stretched the Route puck to three and a half times its own
 * width; being out by the ratio of one phone's width to another's leaves a
 * circle a percent or two oval. The *live* tile does not use this at all — it
 * rasters against the width the launcher reports for that particular copy.
 */
const PREVIEW_CELL_DP = 89;

/** Matches `RidikPlots.ALPHA` — the four levels as opacities. */
const PLOT_ALPHA = [0.18, 0.36, 0.66, 1];

function vector({ width, height }, paths) {
  const body = paths
    .map(
      (p) => `    <path
        android:fillAlpha="${p.alpha.toFixed(2)}"
        android:fillColor="#FFFFFF"
        android:pathData="${p.d}" />`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${width}dp"
    android:height="${height}dp"
    android:viewportWidth="${width}"
    android:viewportHeight="${height}">
${body}
</vector>
`;
}

/** A rounded rectangle as path data, because `<path>` is all a vector has. */
function roundedPath(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  const n = (v) => Number(v.toFixed(2));
  return [
    `M${n(x + radius)},${n(y)}`,
    `H${n(x + w - radius)}`,
    `A${n(radius)},${n(radius)} 0 0 1 ${n(x + w)},${n(y + radius)}`,
    `V${n(y + h - radius)}`,
    `A${n(radius)},${n(radius)} 0 0 1 ${n(x + w - radius)},${n(y + h)}`,
    `H${n(x + radius)}`,
    `A${n(radius)},${n(radius)} 0 0 1 ${n(x)},${n(y + h - radius)}`,
    `V${n(y + radius)}`,
    `A${n(radius)},${n(radius)} 0 0 1 ${n(x + radius)},${n(y)}`,
    'Z',
  ].join(' ');
}

/**
 * A rectangle rounded on one end, the other, both or neither.
 *
 * What lets a run of segments read as one line: only the two outer corners of
 * the whole rail are round, and every join inside it is square.
 */
function capPath(x, y, w, h, r, { left = false, right = false } = {}) {
  const radius = Math.min(r, w / 2, h / 2);
  const n = (v) => Number(v.toFixed(2));
  const arc = (px, py) => `A${n(radius)},${n(radius)} 0 0 1 ${n(px)},${n(py)}`;
  const parts = [`M${n(x + (left ? radius : 0))},${n(y)}`];
  parts.push(`H${n(x + w - (right ? radius : 0))}`);
  if (right) {
    parts.push(arc(x + w, y + radius), `V${n(y + h - radius)}`, arc(x + w - radius, y + h));
  } else {
    parts.push(`V${n(y + h)}`);
  }
  parts.push(`H${n(x + (left ? radius : 0))}`);
  if (left) {
    parts.push(arc(x, y + h - radius), `V${n(y + radius)}`, arc(x + radius, y));
  } else {
    parts.push(`V${n(y)}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

function circlePath(cx, cy, r) {
  const n = (v) => Number(v.toFixed(2));
  return `M${n(cx - r)},${n(cy)} a${n(r)},${n(r)} 0 1 0 ${n(r * 2)},0 a${n(r)},${n(r)} 0 1 0 ${n(-r * 2)},0 Z`;
}

/**
 * A ring, as a vector, for the picker.
 *
 * The live tile fills each ring with `setImageViewBitmap` — `RemoteViews` cannot
 * draw an arc, so `RidikRings.kt` rasters one. Nothing of ours runs in the
 * picker, so the `ImageView` there had no drawable at all and the whole face
 * rendered as an eyebrow over an empty tile: the widget most in need of a
 * preview was the one with none.
 *
 * A vector has **no stroke**, so an arc has to be drawn as a filled annulus
 * sector — the outer edge swept forwards, the inner edge swept back, closed.
 * The numbers are the same numbers: `RidikRings.rate` and `RidikRings.label` in
 * both Swift and Kotlin, restated here so the picker cannot advertise a
 * percentage the tile would not draw.
 */
const RING_VIEWPORT = 100;

/** Matches `RidikRings.STROKE_RATIO` — 4.5 points on a 42-point ring. */
const RING_STROKE = (RING_VIEWPORT * 4.5) / 42;

function ringRate(history) {
  if (!history) return 0;
  return [...history].filter((c) => c === '1').length / history.length;
}

function ringLabel(history) {
  if (!history) return '—';
  const kept = [...history].filter((c) => c === '1').length;
  if (kept >= history.length) return '100%';
  return `${Math.floor((kept * 100) / history.length)}%`;
}

/** One annulus sector, from twelve o'clock clockwise. */
function ringSector(fraction) {
  const n = (v) => Number(v.toFixed(2));
  const c = RING_VIEWPORT / 2;
  const outer = c - RING_STROKE / 2 + RING_STROKE / 2;
  const rMid = c - RING_STROKE / 2;
  const rOut = rMid + RING_STROKE / 2;
  const rIn = rMid - RING_STROKE / 2;
  const sweep = Math.min(Math.max(fraction, 0), 1) * 360;
  // A full sweep has no sector — it is the whole annulus, and a 360° arc with
  // the same start and end point degenerates to nothing at all.
  if (sweep >= 359.9) return annulus(rOut, rIn);
  const at = (deg, r) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [n(c + r * Math.cos(rad)), n(c + r * Math.sin(rad))];
  };
  const large = sweep > 180 ? 1 : 0;
  const [x0, y0] = at(0, rOut);
  const [x1, y1] = at(sweep, rOut);
  const [x2, y2] = at(sweep, rIn);
  const [x3, y3] = at(0, rIn);
  void outer;
  return `M${x0},${y0} A${n(rOut)},${n(rOut)} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${n(rIn)},${n(rIn)} 0 ${large} 0 ${x3},${y3} Z`;
}

/** The full ring, as two circles wound in opposite directions. */
function annulus(rOut, rIn) {
  const n = (v) => Number(v.toFixed(2));
  const c = RING_VIEWPORT / 2;
  return (
    `M${n(c - rOut)},${n(c)} a${n(rOut)},${n(rOut)} 0 1 0 ${n(rOut * 2)},0 a${n(rOut)},${n(rOut)} 0 1 0 ${n(-rOut * 2)},0 Z ` +
    `M${n(c - rIn)},${n(c)} a${n(rIn)},${n(rIn)} 0 1 1 ${n(rIn * 2)},0 a${n(rIn)},${n(rIn)} 0 1 1 ${n(-rIn * 2)},0 Z`
  );
}

function ringPreview(history) {
  const rMid = RING_VIEWPORT / 2 - RING_STROKE / 2;
  const paths = [
    // The track first, at the same alpha `RidikRings.TRACK_ALPHA` uses.
    { alpha: 60 / 255, d: annulus(rMid + RING_STROKE / 2, rMid - RING_STROKE / 2) },
  ];
  const rate = ringRate(history);
  if (rate > 0) paths.push({ alpha: 1, d: ringSector(rate) });
  return vector({ width: RING_VIEWPORT, height: RING_VIEWPORT }, paths);
}

function skylinePreview(box) {
  const { width, height } = box;
  const { load, breaks, spentThrough: spent } = SAMPLE.day;
  const step = width / load.length;
  const floor = height * 0.12;
  const paths = [];
  for (let i = 0; i < load.length; i++) {
    const level = Number(load[i]);
    const behind = i <= spent;
    const full = floor + (height - floor) * (level / 3);
    const tall = behind ? full * 0.38 : full;
    const gap = breaks[i] === '1' ? 3 : 1.5;
    paths.push({
      alpha: PLOT_ALPHA[level] * (behind ? 0.55 : 1),
      d: roundedPath(i * step, height - tall, Math.max(step - gap, 1), tall, 2),
    });
  }
  return vector(box, paths);
}

function sundialPreview(box) {
  const { width, height } = box;
  const { load, spentThrough: spent } = SAMPLE.day;
  const g = sundialGeometry(width, height, load.length);
  const paths = [];

  // The track, as a thin ribbon: a vector has no stroke, so the curve is drawn
  // as a filled sliver offset above and below itself.
  const half = 0.75;
  const top = [];
  const bottom = [];
  for (let i = 0; i <= 48; i++) {
    const [px, py] = g.at(i / 48);
    top.push(`${px.toFixed(2)},${(py - half).toFixed(2)}`);
    bottom.unshift(`${px.toFixed(2)},${(py + half).toFixed(2)}`);
  }
  paths.push({ alpha: PLOT_ALPHA[0], d: `M${top.join(' L')} L${bottom.join(' L')} Z` });

  for (let i = 0; i < load.length; i++) {
    const level = Number(load[i]);
    const behind = i <= spent;
    const [px, py] = g.at((i + 0.5) / load.length);
    paths.push({
      alpha: PLOT_ALPHA[level] * (behind ? 0.55 : 1),
      d: circlePath(px, py, behind ? g.dot * 0.55 : g.dot),
    });
  }
  const [dx, dy] = g.at((spent + 1) / load.length);
  paths.push({ alpha: 1, d: circlePath(dx, dy, g.disc) });
  return vector(box, paths);
}

/**
 * The arc, stated once so the preview and `RidikPlots.sundial` cannot drift.
 *
 * A **quadratic** with its control point at the horizontal midpoint, which makes
 * `x(t)` linear in `t` exactly — so `t` is the fraction of the day elapsed and
 * nothing has to be inverted numerically. Same as `src/features/today/arc.ts`.
 *
 * `dot` is clamped against the *step* and not only against the height: 32 dots
 * across 208dp is 6.5dp each, and a dot sized purely from a 76dp arc is 8.4dp
 * across, so they overlapped into a caterpillar. Nothing about a dot means
 * anything once it touches its neighbour.
 */
function sundialGeometry(width, height, cells) {
  const inset = width * 0.05;
  const step = width / Math.max(cells, 1);
  // Clamped against the step as well as the height, exactly like the dots. The
  // disc is a sun riding the arc; sized from the box alone it grows with any
  // tile taller than it is dense, and past about one step wide it stops being a
  // marker and becomes a blot covering the hours it is sitting on.
  const disc = Math.min(height * 0.13, step * 0.95);
  const dot = Math.min(height * 0.055, step * 0.38);
  const base = height - disc - 2;
  const peak = disc + 2;
  // A quadratic passes at half its control point's offset, so the control is
  // lifted to twice the height the curve should actually reach.
  const control = base - (base - peak) * 2;
  return {
    disc,
    dot,
    at(t) {
      const u = 1 - t;
      return [
        inset + t * (width - inset * 2),
        u * u * base + 2 * u * t * control + t * t * base,
      ];
    },
  };
}

/**
 * The line is continuous and only its ends are rounded.
 *
 * Each segment used to be its own rounded rectangle with a hairline after it,
 * and at thirty-two of them across a tile that is ten units wide by nine tall
 * with a four-unit radius — which is a circle. The face drew as a row of beads
 * rather than as a route. A vector cannot clip the way the Kotlin does, so the
 * caps are drawn instead: the first segment rounded on its left, the last on its
 * right, everything between them square and touching.
 */
function routePreview(box) {
  const { width, height } = box;
  const { load, breaks, spentThrough: spent } = SAMPLE.day;
  const step = width / load.length;
  const thick = height * 0.34;
  const thin = thick * 0.42;
  const mid = height / 2;
  const paths = [];
  for (let i = 0; i < load.length; i++) {
    const level = Number(load[i]);
    const behind = i <= spent;
    const h = behind ? thin : thick;
    // No gap between two cells of the same booking — only where one starts.
    const gap = breaks[i] === '1' ? 2.5 : 0;
    paths.push({
      alpha: PLOT_ALPHA[level] * (behind ? 0.55 : 1),
      d: capPath(i * step, mid - h / 2, Math.max(step - gap, 1), h, h / 2, {
        left: i === 0,
        right: i === load.length - 1,
      }),
    });
  }
  const puck = routePuck(width, height, load.length);
  const px = ((spent + 1) / load.length) * width;
  paths.push({
    alpha: 1,
    d: circlePath(Math.min(Math.max(px, puck), width - puck), mid, puck),
  });
  return vector(box, paths);
}

/**
 * The puck's radius, clamped against the segment step as well as the height.
 *
 * Transit's puck is a marker sitting on a line, and it stops being one the
 * moment it is wider than a few segments — at that point it is a blot covering
 * the part of the day it is supposed to be pointing at.
 */
function routePuck(width, height, cells) {
  return Math.min(height * 0.5, (width / Math.max(cells, 1)) * 1.6);
}

function termPreview(box) {
  const { width, height } = box;
  // 365 days with 241 behind you — the same shape the medium tile draws.
  const total = 365;
  const elapsed = 241;
  const columns = 31;
  const rows = Math.ceil(total / columns);
  const cellW = width / columns;
  const cellH = height / rows;
  const r = Math.max(Math.min(cellW, cellH) / 2 - 0.6, 0.6);
  const paths = [];
  for (let i = 0; i < total; i++) {
    const cx = (i % columns) * cellW + cellW / 2;
    const cy = Math.floor(i / columns) * cellH + cellH / 2;
    // Full size throughout — see `RidikPlots.dots` for why a dot does not burn
    // down the way a cell does.
    if (i < elapsed) paths.push({ alpha: 0.5, d: circlePath(cx, cy, r) });
    else if (i === elapsed) paths.push({ alpha: 1, d: circlePath(cx, cy, r) });
    else paths.push({ alpha: PLOT_ALPHA[0], d: circlePath(cx, cy, r) });
  }
  return vector(box, paths);
}

/**
 * Monday first, and stated here rather than computed.
 *
 * `buildWeek` in `snapshot.ts` starts every week on a Monday regardless of the
 * device's locale, so these seven letters are a constant of the payload and not
 * of the phone. Writing them into the layout is what lets them carry no id: a
 * `RemoteViews` that never has to set them cannot set them wrong.
 */
const CHAIN_DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/**
 * How tall a day reads at each size.
 *
 * Tall enough to fill the tile: seven cells in a band across the top of a
 * two-row widget with nothing under them is the same cheap drawing every other
 * face on this page was making. A day is a *column* here, not a chip.
 */
/**
 * The bar's own height, and the reason medium is 68 rather than 96.
 *
 * A column is a 9sp letter, three of gap, the bar, three more and a 10sp date.
 * At 96 that is a 125dp cell under a 17dp header with ten of padding — 152 of
 * the 130-odd a two-row tile has — so it clipped, and what it clipped was the
 * date row. `RidikChainView` is the other end of these, and it takes less again
 * on a clear week, where the sentence underneath needs the room.
 */
const CHAIN_HEIGHT = { small: 44, medium: 68 };

function chainRow(depth, { ember, size, sample }) {
  const height = CHAIN_HEIGHT[size];
  const columns = CHAIN_DAYS.map((letter, index) => {
    const pad = indent(depth + 6);
    const level = sample ? Number(sample.load[index]) : 0;
    const today = sample ? index === sample.todayIndex : false;
    return `${indent(depth + 2)}<LinearLayout
${pad}android:layout_width="0dp"
${pad}android:layout_height="wrap_content"
${pad}android:layout_weight="1"${index === 0 ? '' : `\n${pad}android:layout_marginStart="4dp"`}
${pad}android:gravity="center_horizontal"
${pad}android:orientation="vertical">

${indent(depth + 4)}<TextView
${indent(depth + 8)}android:layout_width="match_parent"
${indent(depth + 8)}android:layout_height="wrap_content"
${indent(depth + 8)}android:gravity="center"
${indent(depth + 8)}android:includeFontPadding="false"
${indent(depth + 8)}android:maxLines="1"
${indent(depth + 8)}android:text="${letter}"
${indent(depth + 8)}android:textColor="@color/ridik_widget_ink_soft"
${indent(depth + 8)}android:textSize="9sp" />

${indent(depth + 4)}<ImageView
${indent(depth + 8)}android:id="@+id/${IDS.chain(index)}"
${indent(depth + 8)}android:layout_width="match_parent"
${indent(depth + 8)}android:layout_height="${height}dp"
${indent(depth + 8)}android:layout_marginTop="3dp"
${indent(depth + 8)}android:background="@drawable/${heatDrawable(ember, level, today)}"
${indent(depth + 8)}android:importantForAccessibility="no" />

${indent(depth + 4)}<TextView
${indent(depth + 8)}android:id="@+id/${IDS.chainDate(index)}"
${indent(depth + 8)}android:layout_width="match_parent"
${indent(depth + 8)}android:layout_height="wrap_content"
${indent(depth + 8)}android:layout_marginTop="3dp"
${indent(depth + 8)}android:fontFamily="monospace"
${indent(depth + 8)}android:gravity="center"
${indent(depth + 8)}android:includeFontPadding="false"
${indent(depth + 8)}android:maxLines="1"${text(depth + 8, sample ? sample.dates[index] : null)}
${indent(depth + 8)}android:textColor="@color/ridik_widget_ink_soft"
${indent(depth + 8)}android:textSize="10sp" />
${indent(depth + 2)}</LinearLayout>`;
  });

  return `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:id="@+id/${IDS.chainArea}"
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="wrap_content"
${indent(depth + 4)}android:layout_marginTop="10dp"
${indent(depth + 4)}android:baselineAligned="false"
${indent(depth + 4)}android:orientation="horizontal">

${columns.join('\n\n')}
${indent(depth)}</LinearLayout>`;
}

function chainFace({ ember, size, preview }) {
  const sample = preview ? SAMPLE.week : null;
  // "WEEK" on a small tile, matching `RidikChainView` and `RidikRowsFace.chain`:
  // 130dp has to carry the eyebrow, the count and the gap between them, and
  // "THIS WEEK" truncated to "THIS W…" — which promised that something had been
  // left out, and what it left out was the word that mattered. The picker has to
  // agree with the live tile or the card advertises a face nobody gets.
  const eyebrow = size === 'small' ? 'WEEK' : sample && sample.eyebrow;
  const body = [
    header(4, sample ? { ember, size, eyebrow, count: sample.count } : { ember, size }),
    chainRow(4, { ember, size, sample }),
    slack(4),
    copy(4),
  ].join('\n\n');
  return face({ ember, body, preview });
}

/**
 * The rings, laid out in rows of three — with the name *beside* each one.
 *
 * The under-label version of this face did not fit and never had, on either
 * platform. A 56 dp ring with four dp of gap and an eleven-sp name under it is a
 * 73 dp row; two rows plus the header asked for about 189 of the 130-odd dp a
 * two-row tile actually has. Neither WidgetKit nor a launcher complains about
 * that — they clip — so the face shipped with its header cut off the top and the
 * second row's names cut off the bottom.
 *
 * Height is the scarce axis and width is the abundant one: three columns of a
 * 312 dp box is 97 each, and a name reads perfectly well in the 49 the ring does
 * not want. Moving it sideways buys the whole row back, 42 dp instead of 73, and
 * all six habits still show. `RidikRingsView` carries the same arithmetic and
 * the same two numbers.
 */
function ringGrid(depth, { ember, slots, sample }) {
  const perRow = slots > 3 ? 3 : slots;
  const rows = [];
  for (let start = 0; start < slots; start += perRow) {
    const columns = [];
    for (let index = start; index < Math.min(start + perRow, slots); index++) {
      const row = sample && sample.rails && sample.rails[index] ? sample.rails[index] : null;
      const pad = indent(depth + 8);
      columns.push(`${indent(depth + 4)}<LinearLayout
${pad}android:layout_width="0dp"
${pad}android:layout_height="wrap_content"
${pad}android:layout_weight="1"${index === start ? '' : `\n${pad}android:layout_marginStart="10dp"`}
${pad}android:baselineAligned="false"
${pad}android:gravity="center_vertical"
${pad}android:orientation="horizontal">

${indent(depth + 6)}<FrameLayout
${indent(depth + 10)}android:layout_width="${RING_DP}dp"
${indent(depth + 10)}android:layout_height="${RING_DP}dp">

${indent(depth + 8)}<ImageView
${indent(depth + 12)}android:id="@+id/${IDS.ring(index)}"
${indent(depth + 12)}android:layout_width="match_parent"
${indent(depth + 12)}android:layout_height="match_parent"
${indent(depth + 12)}android:importantForAccessibility="no"
${indent(depth + 12)}android:scaleType="fitCenter"${row ? `\n${indent(depth + 12)}android:src="@drawable/ridik_preview_ring_${index}"` : ''}
${indent(depth + 12)}android:tint="@color/${accentColour(ember)}" />

${indent(depth + 8)}<TextView
${indent(depth + 12)}android:id="@+id/${IDS.ringValue(index)}"
${indent(depth + 12)}android:layout_width="match_parent"
${indent(depth + 12)}android:layout_height="match_parent"
${indent(depth + 12)}android:gravity="center"
${indent(depth + 12)}android:includeFontPadding="false"
${indent(depth + 12)}android:maxLines="1"${text(depth + 12, row ? ringLabel(row.history) : null)}
${indent(depth + 12)}android:textColor="@color/ridik_widget_ink"
${indent(depth + 12)}android:textSize="12sp"
${indent(depth + 12)}android:textStyle="bold" />
${indent(depth + 6)}</FrameLayout>

${indent(depth + 6)}<TextView
${indent(depth + 10)}android:id="@+id/${IDS.ringName(index)}"
${indent(depth + 10)}android:layout_width="0dp"
${indent(depth + 10)}android:layout_height="wrap_content"
${indent(depth + 10)}android:layout_weight="1"
${indent(depth + 10)}android:layout_marginStart="6dp"
${indent(depth + 10)}android:ellipsize="end"
${indent(depth + 10)}android:includeFontPadding="false"
${indent(depth + 10)}android:maxLines="2"${text(depth + 10, row ? row.name : null)}
${indent(depth + 10)}android:textColor="@color/ridik_widget_ink_soft"
${indent(depth + 10)}android:textSize="10sp" />
${indent(depth + 4)}</LinearLayout>`);
    }

    rows.push(`${indent(depth + 2)}<LinearLayout
${indent(depth + 6)}android:layout_width="match_parent"
${indent(depth + 6)}android:layout_height="wrap_content"${start === 0 ? '' : `\n${indent(depth + 6)}android:layout_marginTop="10dp"`}
${indent(depth + 6)}android:baselineAligned="false"
${indent(depth + 6)}android:orientation="horizontal">

${columns.join('\n\n')}
${indent(depth + 2)}</LinearLayout>`);
  }

  return `${indent(depth)}<LinearLayout
${indent(depth + 4)}android:id="@+id/${IDS.ringArea}"
${indent(depth + 4)}android:layout_width="match_parent"
${indent(depth + 4)}android:layout_height="wrap_content"
${indent(depth + 4)}android:layout_marginTop="10dp"
${indent(depth + 4)}android:orientation="vertical">

${rows.join('\n\n')}
${indent(depth)}</LinearLayout>`;
}

/**
 * The ring's own height.
 *
 * 42, down from 56. The name moved out from under it, which is what made two
 * rows fit at all — see `ringGrid`. `RidikRingsView.Ring.diameter` is the other
 * end of this, and `RidikRings.STROKE_RATIO` is scaled to match.
 */
const RING_DP = 42;

/** How many rings each size holds without the names colliding. */
/**
 * Six on medium, in two rows of three — every habit the payload carries, and a
 * tile that is full rather than a band over a field of ground.
 */
const RING_SLOTS_BY_SIZE = { small: 2, medium: 6, large: 6 };

function ringsFace({ ember, size, preview }) {
  const sample = preview ? SAMPLE.habits : null;
  const body = [
    header(4, sample ? { ember, size, eyebrow: sample.eyebrow, count: sample.count } : { ember, size }),
    ringGrid(4, { ember, slots: RING_SLOTS_BY_SIZE[size], sample }),
    slack(4),
    copy(4),
  ].join('\n\n');
  return face({ ember, body, preview });
}

function nowNextFace({ ember, size, preview }) {
  // `SAMPLE.today` is a readout and a headline and carries no `rows`, so the
  // three slots drew a label and a bar and nothing else — the picker showed the
  // one face in the family whose whole job is to *answer* saying nothing at all.
  // The agenda's rows are what a slot is built from, and they are already here.
  const sample = preview ? { ...SAMPLE.today, rows: SAMPLE.cal.rows } : null;
  const day = preview ? SAMPLE.day : null;
  const big = size === 'large';
  const parts = [
    header(4, sample ? { ember, size, eyebrow: sample.eyebrow, count: sample.count } : { ember, size }),
    // `big` here is about the *heat*, not the size: the element below is the
    // tile's one hot object at both sizes now, so the slots step down to
    // mid / low / cold at both. §1.1 allows exactly one.
    slots(4, { ember, big: true, sample }),
  ];
  // §2 rule 1 — extra height buys more cells before it buys air. Medium draws
  // the element too: three words across the top of a two-row tile and nothing
  // under them was the same cheap drawing the rest of this page was making, and
  // the strip is the one thing that can fill it while saying something. The
  // element and the rows are the same generators Today and Calendar use, so this
  // face and a Today tile beside it draw the identical strip.
  parts.push(slack(4));
  parts.push(element(4, { ember, size, sample: day, ruler: big }));
  if (big) {
    parts.push(rows(4, { ember, slots: 4, leadWidth: LEAD.wide, sample, fill: false }));
  }
  parts.push(copy(4));
  return face({ ember, body: parts.join('\n\n'), preview });
}

function listFace({ ember, size, preview }) {
  const sample = preview ? SAMPLE.list : null;
  const body = [
    header(4, sample ? { ember, size, eyebrow: sample.eyebrow, count: sample.count } : { ember, size }),
    // The marks first and the sentence under them — §4, and where iOS puts it.
    // "All twelve done." above the column it is about read as a heading for a
    // list that then contradicted it.
    tickRows(4, { ember, slots: LIST_ROW_SLOTS_BY_SIZE[size], sample, fill: false }),
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
      case 'nownext':
        return nowNextFace({ ember, size, preview });
      case 'focus':
        return focusFace({ ember, size, preview });
      case 'horizon':
        return plotFace({
          ember,
          kind: 'horizon',
          size,
          preview,
          eyebrow: SAMPLE.today.eyebrow,
          count: SAMPLE.today.count,
          note: '15:00  ·  Materials lab',
        });
      case 'sundial':
        return plotFace({
          ember,
          kind: 'sundial',
          size,
          preview,
          eyebrow: SAMPLE.today.eyebrow,
          count: SAMPLE.today.count,
          note: '6h 20m left today',
        });
      case 'route':
        return plotFace({
          ember,
          kind: 'route',
          size,
          preview,
          eyebrow: SAMPLE.today.eyebrow,
          count: SAMPLE.today.count,
          note: '3 stops left  ·  next 15:00',
        });
      case 'term':
        return plotFace({
          ember,
          kind: 'term',
          size,
          preview,
          eyebrow: '2026',
          count: 'DAY 242',
          note: '123 days left',
        });
      case 'countdown':
        return countdownFace({ ember, size, preview });
      case 'chain':
        return chainFace({ ember, size, preview });
      case 'rings':
        return ringsFace({ ember, size, preview });
      case 'people':
        return peopleFace({ ember, size, preview });
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
    android:minWidth="${widget.minWidthDp ?? widget.cells.width * 60}dp"
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

function speakStrings() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<resources>
  <string name="${MIC_LABEL}">Speak to Ridik</string>
  <string name="${TILE_LABEL}">Speak</string>
</resources>
`;
}

/**
 * The microphone, as a path rather than as a bitmap.
 *
 * A `VectorDrawable` is native from API 21 and this ships to 26, so no support
 * library is involved and nothing has to be rasterised at the app's density and
 * shipped through Binder — which is the same reason §8 of WIDGETS.md refuses
 * bitmaps for the cells. Drawn white and tinted by the `ImageView`, so one file
 * serves all three embers and both schemes.
 */
function micDrawable() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
  <path
      android:fillColor="#FFFFFFFF"
      android:pathData="M12,14c1.66,0 3,-1.34 3,-3V5c0,-1.66 -1.34,-3 -3,-3S9,3.34 9,5v6c0,1.66 1.34,3 3,3z" />
  <path
      android:fillColor="#FFFFFFFF"
      android:pathData="M17,11c0,2.76 -2.24,5 -5,5s-5,-2.24 -5,-5H5c0,3.53 2.61,6.43 6,6.92V21h2v-3.08c3.39,-0.49 6,-3.39 6,-6.92h-2z" />
</vector>
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
      `  <color name="${bloomColour(name)}">${bloomOf(name, scheme)}</color>`,
      `  <color name="${bloomColour(name)}_out">${bloomOutOf(name, scheme)}</color>`,
    ];
  }).join('\n');
}

/**
 * The tile's own furniture, plus the default ember's `on_heat`.
 *
 * `heat` used to be a hand-written duplicate of `EMBERS.ember[scheme]` guarded
 * by a throw, on the reasoning that `widget-tokens.test.ts` reads this file as
 * *text* and a derived value would leave it nothing to find. That reasoning was
 * wrong in the way duplicates usually are: the guard only proved the two copies
 * agreed with each other, and they did, while both disagreed with the ground
 * they had been solved against. The test now reads the *generated XML* — the
 * artifact Android actually ships — which cannot drift from what is written
 * because it is what is written.
 */
function colors(scheme, { ground, ink, inkSoft, danger, heat, rim, edge }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<resources>
  <color name="ridik_widget_ground">${ground}</color>
  <color name="ridik_widget_ink">${ink}</color>
  <color name="ridik_widget_ink_soft">${inkSoft}</color>
  <color name="ridik_widget_danger">${danger}</color>
  <color name="ridik_widget_on_heat">${heat.onHeat}</color>
  <color name="ridik_widget_well">${DEPTH[scheme].well}</color>
  <color name="ridik_widget_well_floor">${DEPTH[scheme].wellFloor}</color>
  <color name="ridik_widget_bevel">${DEPTH[scheme].bevel}</color>
  <color name="ridik_widget_rim">${rim}</color>
  <color name="ridik_widget_edge">${edge}</color>
${emberColors(scheme)}
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
 *
 * The bevel on a lit cell adds no files to that count, which is the reason it
 * is drawn the way it is: the highlight is `@color/ridik_widget_bevel`, a
 * reference the *launcher* resolves against its own night mode, so one file
 * carries both schemes. A bevel baked as a lightened hex would have doubled
 * twenty-four drawables and put a colour resolved in this process onto a tile
 * drawn in another — which is the night-mode bug this whole indirection exists
 * to avoid, re-introduced as a flourish.
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
 *
 * **A lit cell is bevelled and an unlit one is not**, which is where most of
 * the family's depth comes from: `mid` and `hot` sit proud of the well they are
 * in, `cold` and `low` lie flat in it. The unlit marks nearly disappear and the
 * lit ones carry the drawing — the same reading as "pale unlit, saturated lit",
 * done with an edge instead of another colour.
 *
 * It is built the only way a widget can build one. A lighter shape fills the
 * whole cell, the ember fill is inset a dp from the top, and the dp that shows
 * is a highlight along the cell's top edge. No shadow, no gradient, no bitmap —
 * two flat shapes and an inset.
 *
 * The bevel follows `level` and not `fill`, exactly as the hairline does, and
 * skips a plate cell that carries the ring: a highlight and a 1.5dp ring on a
 * 17dp square is two edges arguing, and the ring is the one that means "today".
 */
function cellShape(ember, level, fill, { today, scheme }) {
  // The ring goes on top of the fill on the plate's today cell, so the day it
  // marks is not made smaller than the ones around it.
  const stroke = today
    ? `\n      <stroke android:width="1.5dp" android:color="@color/${accentColour(ember)}" />`
    : level === 3
      ? `\n      <stroke android:width="1dp" android:color="@color/ridik_widget_${
          scheme === 'dark' ? 'rim' : 'ground'
        }" />`
      : '';

  const solid = `<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="rectangle">
  <solid android:color="@color/${heatColour(ember, fill)}" />
  <corners android:radius="2dp" />${stroke.replace(/\n {6}/g, '\n  ')}
</shape>`;

  const bevelled = `<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
  <item>
    <shape android:shape="rectangle">
      <solid android:color="@color/ridik_widget_bevel" />
      <corners android:radius="2dp" />
    </shape>
  </item>
  <item android:top="1dp">
    <shape android:shape="rectangle">
      <solid android:color="@color/${heatColour(ember, fill)}" />
      <corners android:radius="2dp" />${stroke}
    </shape>
  </item>
</layer-list>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
${level >= 2 && !today ? bevelled : solid}
`;
}

/**
 * The recessed track a run of cells sits inside.
 *
 * Neutral by construction — black and white at an alpha, never the ember — so
 * one file serves all three, and both schemes, with the launcher resolving
 * which pair of alphas it is drawing. Three layers and no gradient:
 *
 *  1. the recess, the whole track darkened a little;
 *  2. the **lip**, the same darkening again across the top 2dp, so the edge the
 *     light would not reach is the darkest part of it;
 *  3. the **floor**, one dp of light along the bottom, where it would.
 *
 * That is the entire trick. A widget cannot cast a shadow and on Android cannot
 * even ask for one, so depth has to be made out of the two edges a shadow would
 * have produced — and two flat rectangles will do it if they are on the right
 * sides. Doubling the lip rather than naming a second colour keeps the palette
 * at the four values `theme.ts` solved.
 *
 * `gravity` with a height on a layer-list item is API 23; this ships to 26.
 * `fill_horizontal` is not decoration either: `Gravity.apply` needs a width
 * from somewhere, and a `<shape>` has no intrinsic one — without it the sliver
 * is laid out against -1 and does not appear at all.
 */
function well() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
  <item>
    <shape android:shape="rectangle">
      <solid android:color="@color/ridik_widget_well" />
      <corners android:radius="5dp" />
    </shape>
  </item>
  <item
      android:gravity="top|fill_horizontal"
      android:height="2dp">
    <shape android:shape="rectangle">
      <solid android:color="@color/ridik_widget_well" />
      <corners android:radius="2dp" />
    </shape>
  </item>
  <item
      android:gravity="bottom|fill_horizontal"
      android:height="1dp">
    <shape android:shape="rectangle">
      <solid android:color="@color/ridik_widget_well_floor" />
      <corners android:radius="1dp" />
    </shape>
  </item>
</layer-list>
`;
}

/**
 * The tile itself: a pale ground with one corner lit.
 *
 * The ground is `tile` and not the app's `bg`. The app is a hero screen and can
 * be a saturated field; a widget is a guest on somebody else's home screen and
 * the same saturation between other apps' tiles reads as shouting — which is
 * also what made the ramp on it look washed out, because a resting cell was
 * only 1.39:1 off its own ground. On this one it is 1.56.
 *
 * **The bloom is the only gradient in the family and it is local on purpose.** A
 * gradient across a whole tile is a wash, and a wash reads as printed; a
 * gradient across one corner reads as a light source, which is the idea the
 * palette is named after. It is the ember at 12% (light) or 24% (dark), fading
 * to the *same hue* at zero alpha — never `@android:color/transparent`, which
 * is transparent black and would drag the falloff through grey.
 *
 * 80% of the tile's short side, not of its width. A `<gradient>` radius given
 * as a fraction is always resolved against `min(width, height)`, so the same
 * number is a bloom over most of a square small tile and a bloom over a third
 * of a wide medium one — which is the right answer both times, because what has
 * to stay true is that it is a corner and not a wash.
 *
 * Dark carries a 1dp border and light carries none: a near-black tile on a dark
 * photo wallpaper otherwise dissolves into it. That is a defect fix, not a
 * flourish, which is why it is here and not in a theme.
 */
function ground(radius, { night, ember }) {
  const border = !night
    ? ''
    : `

  <item>
    <shape android:shape="rectangle">
      <stroke android:width="1dp" android:color="@color/ridik_widget_edge" />
      <corners android:radius="${radius}" />
    </shape>
  </item>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
  <item>
    <shape android:shape="rectangle">
      <solid android:color="@color/ridik_widget_ground" />
      <corners android:radius="${radius}" />
    </shape>
  </item>

  <item>
    <shape android:shape="rectangle">
      <gradient
          android:centerX="0.06"
          android:centerY="0.05"
          android:endColor="@color/${bloomColour(ember)}_out"
          android:gradientRadius="80%p"
          android:startColor="@color/${bloomColour(ember)}"
          android:type="radial" />
      <corners android:radius="${radius}" />
    </shape>
  </item>${border}
</layer-list>
`;
}

/** The entry a rastered face's preview needs its geometry from. */
function widgetOf(kind) {
  const found = WIDGETS.find((widget) => widget.kind === kind);
  if (!found) throw new Error(`No widget declared for kind '${kind}'`);
  return found;
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

    // The mic's accessible name. A `contentDescription` is the *only* thing
    // TalkBack has to go on here — the glyph carries no text, and a widget
    // cannot be explored by anything else.
    'values/ridik_widget_speak.xml': speakStrings(),
    [`drawable/${MIC_DRAWABLE}.xml`]: micDrawable(),

    'raw/ridik_widget_keep.xml': keepRules(),

    // The four rastered faces, as vectors, for the picker alone — see
    // `PLOT_VIEWPORT`. The live tiles set a bitmap over these.
    'drawable/ridik_preview_horizon.xml': skylinePreview(plotViewport('horizon', widgetOf('horizon'))),
    'drawable/ridik_preview_sundial.xml': sundialPreview(plotViewport('sundial', widgetOf('sundial'))),
    'drawable/ridik_preview_route.xml': routePreview(plotViewport('route', widgetOf('route'))),
    'drawable/ridik_preview_term.xml': termPreview(plotViewport('term', widgetOf('term'))),

    // One per ring the medium face draws — see `ringPreview`.
    ...Object.fromEntries(
      SAMPLE.habits.rails
        .slice(0, RING_SLOTS_BY_SIZE[widgetOf('rings').previewSize])
        .map((rail, index) => [`drawable/ridik_preview_ring_${index}.xml`, ringPreview(rail.history)]),
    ),

    // Linen and a warm near-black — the widget's own tile, and deliberately not
    // the app's saturated field. A widget sits between other apps' tiles and
    // the same saturation there reads as shouting; it also measured worse,
    // because a resting cell separated from the old ground by 1.39:1 and from
    // this one by 1.56. `src/ui/theme.ts` → `tile` is the other end of it.
    //
    // Nothing here is a neutral grey; on this palette one would read as a bug.
    // The ground, the ink and the tile's furniture are the same under every
    // ember — only the heat and the bloom change, which is the whole point of a
    // palette built from one colour at four opacities.
    //
    // `heat` is derived, not spelled out. It was a hand-written copy of the
    // default ember's ramp for several releases, on the reasoning that
    // `widget-tokens.test.ts` parsed it out of this file as text and a derived
    // value would leave the test nothing to read. Two things were wrong with
    // that. The test now reads what `resourceFiles()` *returns*, so it checks
    // the artifact rather than the source; and of the five values in the block
    // only `onHeat` was ever written — `emberColors()` generates the four ramp
    // steps from `EMBERS`. So the copy was dead and, by the time anyone looked,
    // four re-solved values out of date, under a comment claiming a guard that
    // had been removed. Dead, wrong, and documented as safe.
    'values/ridik_widget_colors.xml': colors('light', {
      ground: TILE.light,
      ink: '#2E1508',
      inkSoft: '#BD2E1508',
      danger: '#A34133',
      // Transparent rather than absent, and that distinction broke the release
      // build for as long as it has existed.
      //
      // The rim and the edge are dark-only effects — see the note on the night
      // block below — and they used to be expressed by *omitting* them here.
      // But `drawable/` is unqualified, and the tile border drawable references
      // `@color/ridik_widget_edge`, so a light-configured device resolved a
      // colour that had a value in exactly one configuration and none in its
      // own. Android's answer to that is `Resources$NotFoundException`, in the
      // launcher's process, which is a widget that fails to draw rather than a
      // widget that draws plainly.
      //
      // `lintVital` catches it as MissingDefaultResource — and `lintVital` only
      // runs for release, so every debug build passed and no release build has
      // ever completed. A fully transparent stroke *is* "no border", so this
      // says what the design meant and always resolves.
      rim: NOTHING,
      edge: NOTHING,
      heat: defaultHeat('light'),
    }),

    // The launcher can be in dark mode while the app is not, so the widget
    // answers to the system rather than to the app's own scheme.
    'values-night/ridik_widget_colors.xml': colors('dark', {
      ground: TILE.dark,
      ink: '#FFEEDF',
      inkSoft: '#A8FFEEDF',
      danger: '#EB8070',
      // Dark only: a hairline inside the hot cell so emission reads as glow,
      // and a tile border, because a near-black tile on a dark photo wallpaper
      // otherwise dissolves into it. Both are furniture and neither follows the
      // ember — a 1dp hairline is read as light, not as a colour.
      rim: '#FFB57E',
      edge: '#1FFFD6B8',
      heat: defaultHeat('dark'),
    }),

    [`drawable/${WELL}.xml`]: well(),

    // One tile per ember, because the bloom in its corner *is* the ember. Four
    // config variants each: the launcher picks light or dark, and Android 12
    // picks its own corner radius — matching that is the difference between a
    // rounded card and a rounded card with a sliver of wallpaper in each corner.
    ...Object.fromEntries(
      EMBER_NAMES.flatMap((ember) => [
        [`drawable/${groundDrawable(ember)}.xml`, ground('20dp', { night: false, ember })],
        [
          `drawable-v31/${groundDrawable(ember)}.xml`,
          ground(SYSTEM_RADIUS, { night: false, ember }),
        ],
        [`drawable-night/${groundDrawable(ember)}.xml`, ground('20dp', { night: true, ember })],
        [
          `drawable-night-v31/${groundDrawable(ember)}.xml`,
          ground(SYSTEM_RADIUS, { night: true, ember }),
        ],
      ]),
    ),
  };
}

/**
 * Deletes anything this file used to write and no longer does.
 *
 * `android/` is not wiped between prebuilds unless `--clean` is passed, so a
 * layout that was renamed leaves its predecessor behind — still compiling,
 * still referencing ids nothing sets, and still the file the launcher inflates
 * if a stale provider XML happens to name it.
 *
 * The sweep matches `ridik_*.xml`, and that prefix names the **app**, not this
 * plugin — which made this function delete another plugin's resources the first
 * time a second one wrote to `res/`. `withRidikAndroidBackup.js` writes the
 * device-backup rules the manifest points at; they were removed on every
 * prebuild, the manifest kept naming them, and Android silently fell back to
 * backing up nothing. Anything owned elsewhere has to be named here.
 */
const FOREIGN_RESOURCES = new Set(
  ['xml/ridik_backup_rules.xml', 'xml/ridik_data_extraction_rules.xml'].map((relative) =>
    path.normalize(relative),
  ),
);

function prune(res, generated) {
  const keep = new Set(Object.keys(generated).map((relative) => path.normalize(relative)));
  if (!fs.existsSync(res)) return;
  for (const folder of fs.readdirSync(res)) {
    const directory = path.join(res, folder);
    if (!fs.statSync(directory).isDirectory()) continue;
    for (const file of fs.readdirSync(directory)) {
      if (!/^ridik_.*\.xml$/.test(file)) continue;
      const relative = path.normalize(`${folder}/${file}`);
      if (FOREIGN_RESOURCES.has(relative)) continue;
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
 * The Quick Settings tile — the twin of the iOS Control Center button.
 *
 * A `<service>` rather than a `<receiver>`, and the only one this plugin adds.
 * It draws nothing from the snapshot: a tile has no size, no layout and no
 * update period, so it is a glyph, a word and a URL, which is the whole reason
 * it costs one file on each platform rather than a sixth face.
 *
 * `BIND_QUICK_SETTINGS_TILE` is what makes it a tile at all — without it the
 * system will not bind, and the failure is that the tile simply never appears in
 * the edit list, with nothing logged. Exported for the same reason the widget
 * receivers are: the system is the caller.
 */
const TILE_SERVICE = 'ai.dby.ridik.widgets.RidikSpeakTileService';

function tileService() {
  return {
    $: {
      'android:name': TILE_SERVICE,
      'android:exported': 'true',
      'android:icon': `@drawable/${MIC_DRAWABLE}`,
      'android:label': `@string/${TILE_LABEL}`,
      'android:permission': 'android.permission.BIND_QUICK_SETTINGS_TILE',
    },
    'intent-filter': [
      { action: [{ $: { 'android:name': 'android.service.quicksettings.action.QS_TILE' } }] },
    ],
  };
}

/**
 * Pure, and exported, so the tile can be asserted without a prebuild — the same
 * reasoning as `resourceFiles()`. A manifest entry that never reaches the
 * manifest is invisible: the tile simply is not in the edit list, and nothing
 * anywhere says why.
 */
function addSpeakTile(application) {
  // Filtered rather than appended, exactly as the receivers are: `android/` is
  // not wiped between prebuilds, and two services for one class is a manifest
  // merger failure rather than a duplicate tile.
  application.service = [
    ...(application.service ?? []).filter(
      (existing) => existing.$?.['android:name'] !== TILE_SERVICE,
    ),
    tileService(),
  ];
  return application;
}

const withSpeakTile = (config) =>
  withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error('withRidikAndroidWidget: the manifest has no <application> to add to.');
    }
    addSpeakTile(application);
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
 * that ships to API 26 — fifty-three layouts and about 2.1MB of XML through
 * aapt2. Measured: 6GB still carries it with room to spare, so the number is
 * unchanged. It is stated here rather than in the app config because this
 * plugin is the only reason it is needed at all.
 *
 * Depth cost nine more drawables and not one layout: the bevel folded into the
 * heat shapes that already existed, the well is one neutral file for the whole
 * family, and only the tile had to go per-ember, because the bloom in its
 * corner is the ember. Seventy-one drawables against sixty-two.
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
  return withBuildHeap(withSpeakTile(withWidgetReceiver(withWidgetResources(config))));
};

/**
 * The resource map, for `src/ui/__tests__/widget-tokens.test.ts`.
 *
 * The test used to read the *written* XML out of `android/`, which is both
 * gitignored and only present after a prebuild — so on a fresh clone the
 * assertions did not fail, they errored, and in CI they never ran at all.
 * Calling the generator gives the same strings with no build step and no
 * checked-in artefact, which is the only version of this test that is worth
 * anything on a machine that has never run `expo prebuild`.
 */
module.exports.resourceFiles = resourceFiles;

/**
 * The Quick Settings tile's manifest entry, for
 * `src/features/voice/__tests__/speak-intent.test.tsx`. Same reasoning as
 * `resourceFiles`: an entry that never lands is a tile that never appears, with
 * nothing failing and nothing logged.
 */
module.exports.addSpeakTile = addSpeakTile;
