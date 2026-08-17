package ai.dby.ridik.widgets

import android.content.Context

/**
 * The one thing the app process and the widget process both touch.
 *
 * A widget wakes in its own process with no access to the app's JavaScript or
 * its SQLite file, so the payload has to be left somewhere the OS will hand to
 * both. SharedPreferences is that place: same UID, no permissions, no service
 * to keep alive.
 *
 * The name and key are constants rather than plugin-injected strings because
 * both sides of the handover live in this Gradle module — nothing outside it
 * ever needs to know where the JSON is parked.
 */
internal object WidgetSnapshotStore {
  private const val FILE = "ai.dby.ridik.widgets"
  private const val KEY = "snapshot"

  /**
   * `commit()` rather than `apply()`: this already runs off the main thread on
   * an Expo async queue, and the redraw that follows can outlive the app
   * process. An `apply()` still in flight when the process is killed would
   * leave the widget rendering the previous face for good.
   */
  fun write(context: Context, json: String) {
    prefs(context).edit().putString(KEY, json).commit()
  }

  fun read(context: Context): String? = prefs(context).getString(KEY, null)

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
}
