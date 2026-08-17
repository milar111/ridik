package ai.dby.ridik.widgets

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * The microphone, in Quick Settings.
 *
 * The twin of `RidikSpeakControl` on iOS, and it ships with it or not at all: a
 * quick-capture button that exists on one platform and not the other is the "two
 * different products" failure AGENTS.md is about, arriving through the one door
 * nobody would spot in a screenshot comparison.
 *
 * A tile is not a widget and shares nothing with one. It reads no snapshot, has
 * no size, no layout and no update period — it is a mic glyph, a word, and a
 * URL. That is why it costs a file rather than a face.
 *
 * Three things here are the platform being awkward rather than choices:
 *
 * - **`startActivityAndCollapse` changed shape in API 34.** The `Intent`
 *   overload throws `UnsupportedOperationException` outright once the app
 *   targets 34, and the `PendingIntent` overload does not exist below it. Both
 *   branches are load-bearing on a build that targets 36 and ships to 26.
 * - **A locked phone has to be unlocked first.** Launching straight from the
 *   lock screen puts the app behind the keyguard, where it is running, holding
 *   the microphone, and invisible. `unlockAndRun` is the supported way to ask,
 *   and it is a no-op on a phone that is already open.
 * - **`STATE_INACTIVE`, never `STATE_ACTIVE`.** The tile is a button, not a
 *   switch: nothing about the app is "on" while it sits there, and a tile that
 *   paints itself lit is claiming a state it does not have.
 */
class RidikSpeakTileService : TileService() {
  override fun onStartListening() {
    super.onStartListening()
    val tile = qsTile ?: return
    tile.state = Tile.STATE_INACTIVE
    tile.updateTile()
  }

  override fun onClick() {
    super.onClick()
    if (isLocked) unlockAndRun { open() } else open()
  }

  // On the function rather than the call: the pre-34 branch is deprecated *and*
  // load-bearing, because the overload that replaces it does not exist below 34.
  @Suppress("DEPRECATION")
  private fun open() {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(SPEAK_TARGET))
      .setPackage(packageName)
      // Launched from a service, so there is no task to land in.
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startActivityAndCollapse(
        PendingIntent.getActivity(
          this,
          TILE_REQUEST,
          intent,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
      )
    } else {
      startActivityAndCollapse(intent)
    }
  }
}

/**
 * Its own request code. The widget taps hold 0 through 4, the header mic holds
 * 800 and the leave alarm 900 — `FLAG_UPDATE_CURRENT` matches on the code, so a
 * shared one would let whichever intent was built last answer for both.
 */
private const val TILE_REQUEST = 801
