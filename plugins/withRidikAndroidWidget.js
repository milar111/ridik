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

function resourceFiles() {
  return {
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
      wash: '#1FC7360F',
    }),

    // The launcher can be in dark mode while the app is not, so the widget
    // answers to the system rather than to the app's own scheme.
    'values-night/ridik_widget_colors.xml': colors({
      ground: '#1C0E06',
      ink: '#FFEEDF',
      inkSoft: '#A8FFEEDF',
      ember: '#FF8253',
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

function colors({ ground, ink, inkSoft, ember, wash }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GENERATED} -->
<resources>
  <color name="ridik_widget_ground">${ground}</color>
  <color name="ridik_widget_ink">${ink}</color>
  <color name="ridik_widget_ink_soft">${inkSoft}</color>
  <color name="ridik_widget_ember">${ember}</color>
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

const withWidgetReceiver = (config) =>
  withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error('withRidikAndroidWidget: the manifest has no <application> to add to.');
    }

    const receivers = (application.receiver ?? []).filter(
      (receiver) => receiver.$?.['android:name'] !== PROVIDER_CLASS,
    );

    receivers.push({
      $: {
        'android:name': PROVIDER_CLASS,
        // The system, not another app, is what broadcasts APPWIDGET_UPDATE, and
        // it can only reach an exported receiver. Nothing is trusted from the
        // broadcast itself — every redraw re-reads the app's own preferences.
        'android:exported': 'true',
        'android:label': '@string/ridik_widget_label',
      },
      'intent-filter': [
        {
          action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }],
        },
      ],
      'meta-data': [
        {
          $: {
            'android:name': 'android.appwidget.provider',
            'android:resource': `@xml/${INFO}`,
          },
        },
      ],
    });

    application.receiver = receivers;
    return config;
  });

module.exports = function withRidikAndroidWidget(config) {
  return withWidgetReceiver(withWidgetResources(config));
};
