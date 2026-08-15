package ai.raisen.ridik.widgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context

/**
 * The receiver the launcher talks to.
 *
 * It is woken from three directions and all of them do the same thing: read
 * whatever the app last left in SharedPreferences and redraw. There is no state
 * to keep — the process this runs in is gone again a few milliseconds later.
 *
 *   - the launcher, when the widget is placed, restored or the device boots
 *   - the OS, every `updatePeriodMillis`, which is what keeps the "yesterday's
 *     plan" warning honest on a day the app is never opened
 *   - the app itself, through `redrawAll` after publishing a new snapshot
 */
class RidikWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    val views = RidikWidgetFace.build(context) ?: return
    appWidgetManager.updateAppWidget(appWidgetIds, views)
  }

  internal companion object {
    /**
     * Push a redraw at every placed copy of the widget.
     *
     * Deliberately not a broadcast: the caller is already off the main thread
     * with the new snapshot committed, and going through the system would only
     * add a round trip before landing back in `onUpdate`.
     */
    fun redrawAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context) ?: return
      val ids = manager.getAppWidgetIds(ComponentName(context, RidikWidgetProvider::class.java))
      if (ids.isEmpty()) return
      val views = RidikWidgetFace.build(context) ?: return
      manager.updateAppWidget(ids, views)
    }
  }
}
