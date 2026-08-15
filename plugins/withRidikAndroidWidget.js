/**
 * The Android home-screen widget's manifest entry and resources.
 *
 * The Kotlin lives in `modules/ridik-widgets/`, which is ordinary source and
 * needs no help surviving anything. Resources are the part that would not: they
 * have to land in the *app* module, and `android/` is regenerated from the Expo
 * template on every `prebuild --clean`. So they are written here instead of
 * committed, and the two halves meet by name — `RidikWidgetFace.kt` resolves
 * every id below through `Resources.getIdentifier`, because an Android library
 * cannot see the app's `R`.
 *
 * Rename anything here and the widget goes blank rather than failing to build.
 * The names are listed once, in `WIDGET_IDS`, so at least there is one place to
 * check against.
 */
const fs = require('node:fs');
const path = require('node:path');

const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

const PROVIDER_CLASS = 'ai.raisen.ridik.widgets.RidikWidgetProvider';
const LAYOUT = 'ridik_widget';
const INFO = 'ridik_widget_info';

/** Every id `RidikWidgetFace.kt` looks up. Keep the two lists together. */
const WIDGET_IDS = {
  plan: 'ridik_widget_plan',
  eyebrow: 'ridik_widget_eyebrow',
  time: 'ridik_widget_time',
  title: 'ridik_widget_title',
  aside: 'ridik_widget_aside',
  due: 'ridik_widget_due',
  overdue: 'ridik_widget_overdue',
  habits: 'ridik_widget_habits',
  notice: 'ridik_widget_notice',
  noticeTitle: 'ridik_widget_notice_title',
  noticeBody: 'ridik_widget_notice_body',
};

// -------------------------------------------------------------- the list widgets

/** Must equal `ROW_SLOTS` in `RidikRowsFace.kt` and `ROW_CAP` in `snapshot.ts`. */
const ROW_SLOTS = 6;

/** Every id `RidikRowsFace.RowIds` looks up. Keep the two lists together. */
const ROW_IDS = {
  body: 'ridik_rows_body',
  eyebrow: 'ridik_rows_eyebrow',
  count: 'ridik_rows_count',
  empty: 'ridik_rows_empty',
  list: 'ridik_rows_list',
  notice: 'ridik_rows_notice',
  noticeTitle: 'ridik_rows_notice_title',
  noticeBody: 'ridik_rows_notice_body',
  row: (index) => `ridik_rows_row_${index}`,
  lead: (index) => `ridik_rows_lead_${index}`,
  text: (index) => `ridik_rows_text_${index}`,
  trail: (index) => `ridik_rows_trail_${index}`,
};

/**
 * The four list widgets, each of which is one receiver, one provider XML and
 * one preview.
 *
 * `layout` is the shared face they inflate: three variants of one template that
 * differ only in how much room the lead column reserves. A clock time needs a
 * fixed width or the titles beside it step in and out on every row, and
 * "10:00 AM" needs half again as much of it as "10:00"; a tick needs 16dp, and
 * giving it 46 would indent the whole list for nothing. RemoteViews cannot
 * change a width at runtime, so each is its own layout — `RidikRowsFace` picks
 * between the two timed ones against the device's own clock setting.
 */
const ROWS_LAYOUT = 'ridik_rows';
const ROWS_LAYOUT_AMPM = 'ridik_rows_ampm';
const ROWS_LAYOUT_TIGHT = 'ridik_rows_tight';

const LEAD_WIDTH = { [ROWS_LAYOUT]: 46, [ROWS_LAYOUT_AMPM]: 66, [ROWS_LAYOUT_TIGHT]: 16 };

const ROW_WIDGETS = [
  {
    kind: 'agenda',
    provider: 'ai.raisen.ridik.widgets.RidikAgendaWidgetProvider',
    layout: ROWS_LAYOUT,
    label: 'Ridik — Agenda',
    description: 'Everything still to come today, in order.',
    preview: {
      eyebrow: 'TODAY',
      count: '5 left',
      rows: [
        { lead: '11:00', text: 'Materials lab', trail: 'Workshop 2' },
        { lead: '13:15', text: 'Lunch with Sam', trail: null },
        { lead: '14:30', text: 'Call with Mira', trail: null },
        { lead: '16:00', text: 'Pick up the order', trail: 'Unit 4' },
        { lead: '17:30', text: 'Studio clean-up', trail: null },
      ],
    },
  },
  {
    kind: 'tasks',
    provider: 'ai.raisen.ridik.widgets.RidikTasksWidgetProvider',
    layout: ROWS_LAYOUT,
    label: 'Ridik — Tasks',
    description: 'What is overdue and what is due today, most behind first.',
    preview: {
      eyebrow: 'TASKS',
      count: '1 late',
      countColor: 'ridik_widget_danger',
      rows: [
        { lead: 'late', text: 'Send the deposit', trail: null, leadColor: 'ridik_widget_danger' },
        { lead: '14:00', text: 'Order M4 bolts', trail: null },
        { lead: '16:45', text: 'Reply to the landlord', trail: null },
        { lead: '18:30', text: 'Book the van', trail: null },
        { lead: '5d', text: 'Chase the invoice', trail: null, leadColor: 'ridik_widget_danger' },
      ],
    },
  },
  {
    kind: 'habits',
    provider: 'ai.raisen.ridik.widgets.RidikHabitsWidgetProvider',
    layout: ROWS_LAYOUT_TIGHT,
    label: 'Ridik — Habits',
    description: "Today's habits, the ones still owed first, with their streaks.",
    preview: {
      eyebrow: 'HABITS',
      count: '3/5',
      rows: [
        { lead: '○', text: 'Read', trail: '12d' },
        { lead: '○', text: 'Practice guitar', trail: '5d' },
        { lead: '✓', text: 'Walk', trail: '31d' },
        { lead: '✓', text: 'Stretch', trail: '4d' },
        { lead: '✓', text: 'Journal', trail: '2d' },
      ],
    },
  },
  {
    kind: 'list',
    provider: 'ai.raisen.ridik.widgets.RidikListWidgetProvider',
    layout: ROWS_LAYOUT_TIGHT,
    label: 'Ridik — List',
    description: 'The checklist you still have something open on.',
    preview: {
      eyebrow: 'HARDWARE',
      count: '3 open',
      rows: [
        { lead: '○', text: 'M4 bolts ×20', trail: null },
        { lead: '○', text: 'Threadlock', trail: null },
        { lead: '○', text: 'Sanding discs', trail: null },
        { lead: '✓', text: 'Masking tape', trail: null },
        { lead: '✓', text: 'Wood glue', trail: null },
      ],
    },
  },
];

const GENERATED = 'Written by plugins/withRidikAndroidWidget.js — edit that, not this.';

/**
 * One tree, two uses.
 *
 * `preview` is the face the widget picker shows: it cannot run any of our code,
 * so the only way to show it a plausible widget is to bake sample copy into a
 * second layout. The real one inflates showing the notice, which is the honest
 * state for a widget that has not been handed a snapshot yet — a first frame of
 * plausible-looking sample data would be indistinguishable from live data.
 */
function widgetLayout({ preview }) {
  const plan = preview ? 'visible' : 'gone';
  const notice = preview ? 'gone' : 'visible';
  const sample = (indent, text) => (preview ? `\n${' '.repeat(indent)}android:text="${text}"` : '');

  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@android:id/background"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="@drawable/ridik_widget_ground"
    android:padding="12dp">

  <LinearLayout
      android:id="@+id/${WIDGET_IDS.plan}"
      android:layout_width="match_parent"
      android:layout_height="match_parent"
      android:orientation="vertical"
      android:visibility="${plan}">

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:gravity="center_vertical"
        android:orientation="vertical">

      <TextView
          android:id="@+id/${WIDGET_IDS.eyebrow}"
          android:layout_width="wrap_content"
          android:layout_height="wrap_content"
          android:fontFamily="monospace"
          android:letterSpacing="0.14"
          android:maxLines="1"
          android:text="NEXT"
          android:textAllCaps="true"
          android:textColor="@color/ridik_widget_ember"
          android:textSize="10sp" />

      <LinearLayout
          android:layout_width="match_parent"
          android:layout_height="wrap_content"
          android:layout_marginTop="3dp"
          android:baselineAligned="true"
          android:orientation="horizontal">

        <TextView
            android:id="@+id/${WIDGET_IDS.time}"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:fontFamily="monospace"
            android:includeFontPadding="false"
            android:maxLines="1"${sample(12, '09:40')}
            android:textColor="@color/ridik_widget_ink"
            android:textSize="20sp" />

        <TextView
            android:id="@+id/${WIDGET_IDS.title}"
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_marginStart="9dp"
            android:layout_weight="1"
            android:ellipsize="end"
            android:includeFontPadding="false"
            android:maxLines="1"${sample(12, 'Materials lab')}
            android:textColor="@color/ridik_widget_ink"
            android:textSize="14sp" />
      </LinearLayout>

      <TextView
          android:id="@+id/${WIDGET_IDS.aside}"
          android:layout_width="match_parent"
          android:layout_height="wrap_content"
          android:layout_marginTop="3dp"
          android:ellipsize="end"
          android:maxLines="1"${sample(10, 'Leave 09:15  ·  Building C')}
          android:textColor="@color/ridik_widget_ember"
          android:textSize="11sp" />
    </LinearLayout>

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="8dp"
        android:orientation="horizontal">
${chip(WIDGET_IDS.due, 'ridik_widget_ink_soft', preview ? '4 due' : null, { last: false })}
${chip(WIDGET_IDS.overdue, 'ridik_widget_ember', preview ? '1 overdue' : null, { last: false })}
${chip(WIDGET_IDS.habits, 'ridik_widget_ink_soft', preview ? '2/3 habits' : null, { last: true })}
    </LinearLayout>
  </LinearLayout>

  <LinearLayout
      android:id="@+id/${WIDGET_IDS.notice}"
      android:layout_width="match_parent"
      android:layout_height="match_parent"
      android:gravity="center_vertical"
      android:orientation="vertical"
      android:visibility="${notice}">

    <TextView
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:fontFamily="monospace"
        android:letterSpacing="0.14"
        android:maxLines="1"
        android:text="RIDIK"
        android:textAllCaps="true"
        android:textColor="@color/ridik_widget_ember"
        android:textSize="10sp" />

    <TextView
        android:id="@+id/${WIDGET_IDS.noticeTitle}"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="5dp"
        android:ellipsize="end"
        android:maxLines="1"
        android:text="Nothing published yet"
        android:textColor="@color/ridik_widget_ink"
        android:textSize="16sp" />

    <TextView
        android:id="@+id/${WIDGET_IDS.noticeBody}"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="3dp"
        android:ellipsize="end"
        android:maxLines="2"
        android:text="Open Ridik once and today lands here."
        android:textColor="@color/ridik_widget_ink_soft"
        android:textSize="12sp" />
  </LinearLayout>
</FrameLayout>
`;
}

/**
 * A count reads as a gauge, not a sentence, so each one gets its own pill.
 *
 * Equal weights rather than `wrap_content`: the row has to hold three of these
 * at 180dp and one of them at 400dp, and a weighted cell ellipsises inside its
 * share instead of shoving the last pill off the edge.
 */
function chip(id, colorName, text, { last }) {
  const sample = text ? `\n          android:text="${text}"` : '';
  const gap = last ? '' : '\n          android:layout_marginEnd="5dp"';
  return `      <TextView
          android:id="@+id/${id}"
          android:layout_width="0dp"
          android:layout_height="wrap_content"${gap}
          android:layout_weight="1"
          android:background="@drawable/ridik_widget_chip"
          android:ellipsize="end"
          android:gravity="center"
          android:maxLines="1"
          android:paddingBottom="3dp"
          android:paddingEnd="6dp"
          android:paddingStart="6dp"
          android:paddingTop="3dp"${sample}
          android:textColor="@color/${colorName}"
          android:textSize="11sp" />`;
}

/**
 * The shared list face: a header, six row slots, and the same notice pane the
 * Today widget uses.
 *
 * RemoteViews cannot loop, so the slots are written out and `RidikRowsFace`
 * hides the ones it has nothing for. Six is the payload's own cap — publishing
 * a seventh row would put it nowhere.
 *
 * With `preview` this becomes the tile the widget picker shows. The picker
 * cannot run any of our code, so sample copy is the only way to show it a
 * plausible widget; the real layout inflates showing the notice instead, which
 * is the honest state for a widget nobody has published to yet.
 */
function rowsLayout({ leadWidth, preview }) {
  const body = preview ? 'visible' : 'gone';
  const notice = preview ? 'gone' : 'visible';
  const sampleRows = preview ? preview.rows : [];

  const slots = Array.from({ length: ROW_SLOTS }, (_, index) =>
    rowSlot(index, leadWidth, sampleRows[index])
  ).join('\n\n');

  const count = preview
    ? `\n          android:text="${preview.count}"\n          android:textColor="@color/${preview.countColor || 'ridik_widget_ink_soft'}"`
    : '\n          android:textColor="@color/ridik_widget_ink_soft"';

  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@android:id/background"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="@drawable/ridik_widget_ground"
    android:padding="12dp">

  <LinearLayout
      android:id="@+id/${ROW_IDS.body}"
      android:layout_width="match_parent"
      android:layout_height="match_parent"
      android:orientation="vertical"
      android:visibility="${body}">

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:baselineAligned="true"
        android:orientation="horizontal">

      <TextView
          android:id="@+id/${ROW_IDS.eyebrow}"
          android:layout_width="0dp"
          android:layout_height="wrap_content"
          android:layout_weight="1"
          android:ellipsize="end"
          android:fontFamily="monospace"
          android:letterSpacing="0.14"
          android:maxLines="1"${preview ? `\n          android:text="${preview.eyebrow}"` : ''}
          android:textAllCaps="true"
          android:textColor="@color/ridik_widget_ember"
          android:textSize="10sp" />

      <TextView
          android:id="@+id/${ROW_IDS.count}"
          android:layout_width="wrap_content"
          android:layout_height="wrap_content"
          android:layout_marginStart="6dp"
          android:fontFamily="monospace"
          android:maxLines="1"${count}
          android:textSize="10sp" />
    </LinearLayout>

    <TextView
        android:id="@+id/${ROW_IDS.empty}"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="9dp"
        android:ellipsize="end"
        android:maxLines="2"
        android:textColor="@color/ridik_widget_ink_soft"
        android:textSize="13sp"
        android:visibility="gone" />

    <LinearLayout
        android:id="@+id/${ROW_IDS.list}"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_marginTop="7dp"
        android:layout_weight="1"
        android:orientation="vertical">

${slots}
    </LinearLayout>
  </LinearLayout>

  <LinearLayout
      android:id="@+id/${ROW_IDS.notice}"
      android:layout_width="match_parent"
      android:layout_height="match_parent"
      android:gravity="center_vertical"
      android:orientation="vertical"
      android:visibility="${notice}">

    <TextView
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:fontFamily="monospace"
        android:letterSpacing="0.14"
        android:maxLines="1"
        android:text="RIDIK"
        android:textAllCaps="true"
        android:textColor="@color/ridik_widget_ember"
        android:textSize="10sp" />

    <TextView
        android:id="@+id/${ROW_IDS.noticeTitle}"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="5dp"
        android:ellipsize="end"
        android:maxLines="2"
        android:text="Nothing published yet"
        android:textColor="@color/ridik_widget_ink"
        android:textSize="15sp" />

    <TextView
        android:id="@+id/${ROW_IDS.noticeBody}"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="3dp"
        android:ellipsize="end"
        android:maxLines="3"
        android:text="Open Ridik once and today lands here."
        android:textColor="@color/ridik_widget_ink_soft"
        android:textSize="12sp" />
  </LinearLayout>
</FrameLayout>
`;
}

/**
 * One row: a lead column, the title, and an optional trailing note.
 *
 * The lead is a fixed width rather than `wrap_content` so the titles line up
 * down the list — "9:40" and "11:05" are different widths even in a monospaced
 * face, and a ragged left edge on five rows reads as a rendering fault.
 */
function rowSlot(index, leadWidth, sample) {
  const visibility = sample ? 'visible' : 'gone';
  const gap = index === 0 ? '' : '\n          android:layout_marginTop="5dp"';
  const lead = sample ? `\n            android:text="${sample.lead}"` : '';
  const leadColor = (sample && sample.leadColor) || 'ridik_widget_ember';
  const text = sample ? `\n            android:text="${sample.text}"` : '';
  const trail = sample && sample.trail ? `\n            android:text="${sample.trail}"` : '';
  const trailVisibility = sample && sample.trail ? 'visible' : 'gone';

  return `      <LinearLayout
          android:id="@+id/${ROW_IDS.row(index)}"
          android:layout_width="match_parent"
          android:layout_height="wrap_content"${gap}
          android:baselineAligned="true"
          android:orientation="horizontal"
          android:visibility="${visibility}">

        <TextView
            android:id="@+id/${ROW_IDS.lead(index)}"
            android:layout_width="${leadWidth}dp"
            android:layout_height="wrap_content"
            android:ellipsize="end"
            android:fontFamily="monospace"
            android:includeFontPadding="false"
            android:maxLines="1"${lead}
            android:textColor="@color/${leadColor}"
            android:textSize="11sp" />

        <TextView
            android:id="@+id/${ROW_IDS.text(index)}"
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_marginStart="7dp"
            android:layout_weight="1"
            android:ellipsize="end"
            android:includeFontPadding="false"
            android:maxLines="1"${text}
            android:textColor="@color/ridik_widget_ink"
            android:textSize="12sp" />

        <TextView
            android:id="@+id/${ROW_IDS.trail(index)}"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginStart="7dp"
            android:ellipsize="end"
            android:fontFamily="monospace"
            android:includeFontPadding="false"
            android:maxLines="1"${trail}
            android:textColor="@color/ridik_widget_ink_soft"
            android:textSize="10sp"
            android:visibility="${trailVisibility}" />
      </LinearLayout>`;
}

/**
 * A list widget's `appwidget-provider`.
 *
 * Three cells square by default and resizable in both directions, because the
 * face reads the height back at draw time and cuts the list to fit — see
 * `RidikRowsFace.capacityFor`. The floor is two cells, which still holds a
 * header and two rows.
 */
function rowsInfo(widget) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/ridik_rows_${widget.kind}_description"
    android:initialLayout="@layout/${widget.layout}"
    android:maxResizeHeight="400dp"
    android:maxResizeWidth="400dp"
    android:minHeight="150dp"
    android:minResizeHeight="110dp"
    android:minResizeWidth="140dp"
    android:minWidth="180dp"
    android:previewLayout="@layout/ridik_rows_preview_${widget.kind}"
    android:resizeMode="horizontal|vertical"
    android:targetCellHeight="3"
    android:targetCellWidth="3"
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

function rowsStrings() {
  const lines = ROW_WIDGETS.flatMap((widget) => [
    `  <string name="ridik_rows_${widget.kind}_label">${androidString(widget.label)}</string>`,
    `  <string name="ridik_rows_${widget.kind}_description">${androidString(widget.description)}</string>`,
  ]);
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<resources>
${lines.join('\n')}
</resources>
`;
}

function rowsResources() {
  // Everything about the three is identical but the lead column, which is the
  // point of generating them from one template rather than keeping three
  // layouts in step by hand.
  const files = { 'values/ridik_rows_strings.xml': rowsStrings() };
  for (const [name, leadWidth] of Object.entries(LEAD_WIDTH)) {
    files[`layout/${name}.xml`] = rowsLayout({ leadWidth, preview: null });
  }

  for (const widget of ROW_WIDGETS) {
    files[`layout/ridik_rows_preview_${widget.kind}.xml`] = rowsLayout({
      leadWidth: LEAD_WIDTH[widget.layout],
      preview: widget.preview,
    });
    files[`xml/ridik_rows_${widget.kind}_info.xml`] = rowsInfo(widget);
  }

  return files;
}

/**
 * Stops resource shrinking from deleting the widget.
 *
 * `shrinkResources` keeps what it can *see* referenced, and every id here is
 * reached through `Resources.getIdentifier(name, …)` — a string R8 cannot
 * follow. Most of the tree survives by accident, because the manifest names the
 * provider XML which names the layout which names its colours; but anything
 * reached only from Kotlin is invisible, and `ridik_widget_danger` is exactly
 * that on any build where no preview happens to use it.
 *
 * The failure would not break the build. It would ship a widget that renders
 * blank, or with one colour resolved to 0 and drawn transparent.
 */
function keepRules() {
  const names = [
    '@layout/ridik_*',
    '@xml/ridik_*',
    '@color/ridik_widget_*',
    '@drawable/ridik_widget_*',
    '@string/ridik_widget_*',
    '@string/ridik_rows_*',
  ];
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<resources xmlns:tools="http://schemas.android.com/tools"
    tools:keep="${names.join(',')}"
    tools:shrinkMode="safe" />
`;
}

function resourceFiles() {
  return {
    ...rowsResources(),

    'raw/ridik_widget_keep.xml': keepRules(),

    [`layout/${LAYOUT}.xml`]: widgetLayout({ preview: false }),
    [`layout/${LAYOUT}_preview.xml`]: widgetLayout({ preview: true }),

    /**
     * `targetCellWidth`/`targetCellHeight` are what Android 12 and up actually
     * honour; `minWidth`/`minHeight` are the same 4x2 expressed the old way for
     * everything before it, and set the floor a resize cannot go under.
     *
     * `updatePeriodMillis` is the platform's coarsest setting, and it is here
     * for one reason: the counts are tallied for a calendar day, so on a day
     * the app is never opened the widget has to notice midnight by itself and
     * say the numbers have gone stale. Every other redraw is pushed.
     */
    [`xml/${INFO}.xml`]: `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/ridik_widget_description"
    android:initialLayout="@layout/${LAYOUT}"
    android:maxResizeHeight="220dp"
    android:maxResizeWidth="400dp"
    android:minHeight="110dp"
    android:minResizeHeight="110dp"
    android:minResizeWidth="180dp"
    android:minWidth="250dp"
    android:previewLayout="@layout/${LAYOUT}_preview"
    android:resizeMode="horizontal|vertical"
    android:targetCellHeight="2"
    android:targetCellWidth="4"
    android:updatePeriodMillis="1800000"
    android:widgetCategory="home_screen" />
`,

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
    }),

    'values/ridik_widget_strings.xml': `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<resources>
  <string name="ridik_widget_label">Ridik — Today</string>
  <string name="ridik_widget_description">The next thing, when to leave for it, and what is still due.</string>
</resources>
`,

    'drawable/ridik_widget_ground.xml': ground('20dp'),
    // Android 12 clips widgets to a corner radius it picks itself. Matching it
    // is the difference between a rounded card and a rounded card with a sliver
    // of wallpaper showing through each corner.
    'drawable-v31/ridik_widget_ground.xml': ground(
      '@android:dimen/system_app_widget_background_radius',
    ),

    'drawable/ridik_widget_chip.xml': `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="rectangle">
  <solid android:color="@color/ridik_widget_wash" />
  <corners android:radius="9dp" />
</shape>
`,
  };
}

function colors({ ground, ink, inkSoft, ember, danger, wash }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<resources>
  <color name="ridik_widget_ground">${ground}</color>
  <color name="ridik_widget_ink">${ink}</color>
  <color name="ridik_widget_ink_soft">${inkSoft}</color>
  <color name="ridik_widget_ember">${ember}</color>
  <color name="ridik_widget_danger">${danger}</color>
  <color name="ridik_widget_wash">${wash}</color>
</resources>
`;
}

function ground(radius) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="rectangle">
  <solid android:color="@color/ridik_widget_ground" />
  <corners android:radius="${radius}" />
</shape>
`;
}

const withWidgetResources = (config) =>
  withDangerousMod(config, [
    'android',
    (config) => {
      const res = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');
      for (const [relative, contents] of Object.entries(resourceFiles())) {
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
function receiver({ name, label, info }) {
  return {
    $: {
      'android:name': name,
      'android:exported': 'true',
      'android:label': label,
    },
    'intent-filter': [
      { action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }] },
    ],
    'meta-data': [
      { $: { 'android:name': 'android.appwidget.provider', 'android:resource': info } },
    ],
  };
}

const withWidgetReceiver = (config) =>
  withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error('withRidikAndroidWidget: the manifest has no <application> to add to.');
    }

    const ours = [
      receiver({
        name: PROVIDER_CLASS,
        label: '@string/ridik_widget_label',
        info: `@xml/${INFO}`,
      }),
      ...ROW_WIDGETS.map((widget) =>
        receiver({
          name: widget.provider,
          label: `@string/ridik_rows_${widget.kind}_label`,
          info: `@xml/ridik_rows_${widget.kind}_info`,
        })
      ),
    ];

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

module.exports = function withRidikAndroidWidget(config) {
  return withWidgetReceiver(withWidgetResources(config));
};
