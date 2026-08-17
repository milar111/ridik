package ai.dby.ridik.widgets

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle

/**
 * The receiver the launcher talks to for the Today widget.
 *
 * It is woken from four directions and all of them do the same thing: read
 * whatever the app last left in SharedPreferences and redraw. There is no state
 * to keep — the process this runs in is gone again a few milliseconds later.
 *
 *   - the launcher, when the widget is placed, restored or the device boots
 *   - the OS, every `updatePeriodMillis`, which is the platform floor of thirty
 *     minutes and is what burns the strip down on a day the app is never opened
 *   - the launcher again on a resize, through `onAppWidgetOptionsChanged` —
 *     without which a resize redraws without re-picking the layout variant, and
 *     a tile dragged from two cells to four keeps the small face for ever
 *   - the app itself, through `redrawAll` after publishing a new snapshot
 *
 * The class name is not a display string. Android identifies a widget by its
 * provider class, so renaming this orphans every tile already placed.
 */
class RidikWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) = drawToday(context, appWidgetManager, appWidgetIds)

  override fun onAppWidgetOptionsChanged(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle?,
  ) = drawToday(context, appWidgetManager, intArrayOf(appWidgetId))

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
      drawToday(context, manager, ids)
    }
  }
}

/**
 * One redraw at the instant the travel buffer runs out.
 *
 * The `Chronometer` on the Today face is the only genuinely live element the
 * platform gives for zero wakeups, and it keeps counting once it passes its base
 * — "leave in -04:31" for up to the thirty minutes until the next scheduled
 * redraw. iOS covers that instant with a timeline entry it generates at
 * `leaveAt`; here it takes one alarm, which costs nothing until it fires.
 *
 * Deliberately inexact (`set`, not `setExact`): exact alarms need
 * `SCHEDULE_EXACT_ALARM` on Android 12 and a user-facing justification, and the
 * face already degrades honestly on its own — the alarm only shortens the window
 * in which it has to.
 */
internal object LeaveAlarm {
  /** Its own request code, or it would collide with the tap intents. */
  private const val REQUEST = 900

  fun at(context: Context, leaveAt: Long) {
    val alarms = context.getSystemService(AlarmManager::class.java) ?: return
    val manager = AppWidgetManager.getInstance(context) ?: return
    // The broadcast has to name the ids: `AppWidgetProvider.onReceive` drops an
    // APPWIDGET_UPDATE that carries none, in silence.
    val ids = manager.getAppWidgetIds(ComponentName(context, RidikWidgetProvider::class.java))
    if (ids.isEmpty()) return

    val intent = Intent(context, RidikWidgetProvider::class.java)
      .setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
      .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
    val pending = PendingIntent.getBroadcast(
      context,
      REQUEST,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    // A second past it, so the redraw cannot land on the same millisecond and
    // start the countdown again with nothing left in it.
    alarms.set(AlarmManager.RTC, leaveAt + 1_000L, pending)
  }
}

/**
 * Draws Today into every copy of it that is placed.
 *
 * Per widget id rather than once for all of them, and this is not an
 * optimisation left undone: the face picks its layout from the size the launcher
 * reports, so the same widget is an eight-bucket strip in one corner of the home
 * screen and a thirty-two-cell one in another. Drawing them all from one
 * `RemoteViews` would give every copy whichever size the first one happened to
 * be.
 */
internal fun drawToday(context: Context, manager: AppWidgetManager, ids: IntArray) {
  for (id in ids) {
    val options = manager.getAppWidgetOptions(id)
    val width = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0) ?: 0
    val height = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0) ?: 0
    // `continue`, never `return`. One widget whose layout failed to resolve must
    // not skip every remaining id — that is one broken tile turning into a home
    // screen of stale ones.
    val views = RidikWidgetFace.build(context, width, height) ?: continue
    manager.updateAppWidget(id, views)
  }
}
