package ai.dby.ridik.widgets

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF

/**
 * A completion ring, drawn as a bitmap because RemoteViews cannot draw an arc.
 *
 * The rest of this family is built from one primitive — a rounded rectangle at
 * radius 2 — precisely so that nothing has to be drawn at runtime: every cell is
 * a `@drawable/` reference the launcher resolves in its own process. A ring has
 * no such reference. It is a stroked arc of an arbitrary sweep, and the only way
 * to put one in a `RemoteViews` is `setImageViewBitmap`.
 *
 * ## Why the bitmap is white, and never the ember
 *
 * This is the trap the whole file is arranged around, and it is the same one
 * `AGENTS.md` records for text: **a colour resolved here is resolved in the wrong
 * process.** `resources.getColor()` inside a provider answers against the *app's*
 * configuration; the launcher draws the tile against its own. Flip the system to
 * dark with the app last opened in light and a runtime-coloured ring is drawn
 * near-black onto a near-black tile — invisible, intermittently, and only for
 * some users.
 *
 * So nothing here computes a colour. The ring is drawn as a **white alpha mask**
 * on transparent, and the `ImageView` in the layout carries
 * `android:tint="@color/ridik_widget_heat_3"`. Tint is a colour *reference*, so
 * the launcher resolves it against its own light/dark exactly as it does for
 * every cell and every word on every other face. It is the same trick the mic
 * glyph already uses — one vector, tinted per ember by the layout — applied to a
 * shape that has to be computed instead of drawn once.
 *
 * The track is the same mask at a low alpha rather than a second colour, for the
 * same reason: a second tint would be a second colour reference to keep in step,
 * and the family has exactly one ember.
 */
internal object RidikRings {

  /** The stroke, as a fraction of the ring's diameter. Matches iOS's 4.5pt on 42. */
  private const val STROKE_RATIO = 4.5f / 42f

  /** What the untravelled part of the ring is worth against the swept part. */
  private const val TRACK_ALPHA = 60

  /**
   * One ring at `size` pixels square, sweeping `fraction` of the way round.
   *
   * Starts at twelve o'clock and runs clockwise, which is where every progress
   * ring anyone has ever seen begins. `fraction` is clamped rather than trusted:
   * a sweep past 360° laps the ring and draws a *shorter* arc than a full one,
   * which would make a habit kept every day look worse than one kept most days.
   */
  fun ring(sizePx: Int, fraction: Float): Bitmap {
    val side = sizePx.coerceAtLeast(1)
    val bitmap = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val stroke = side * STROKE_RATIO
    // Inset by half the stroke: a stroke straddles its path, so a ring drawn on
    // the bounding box is clipped by its own bitmap on all four sides.
    val inset = stroke / 2f
    val box = RectF(inset, inset, side - inset, side - inset)

    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = stroke
      strokeCap = Paint.Cap.ROUND
      color = Color.WHITE
    }

    // The track first, then the sweep over it.
    paint.alpha = TRACK_ALPHA
    canvas.drawArc(box, 0f, 360f, false, paint)

    val swept = fraction.coerceIn(0f, 1f)
    if (swept > 0f) {
      paint.alpha = 255
      canvas.drawArc(box, -90f, 360f * swept, false, paint)
    }
    return bitmap
  }

  /**
   * The share of a habit's window that was kept, from its history string.
   *
   * `history` is `HABIT_HISTORY_DAYS` characters of '0' and '1' ending on the day
   * the snapshot describes, so every character is a day that has *happened* —
   * there is no future to exclude here the way there is in the app's own grid,
   * where the five-week board runs to the end of the current week.
   *
   * An empty string answers 0 rather than dividing: a payload from a build that
   * did not send history is not a habit nobody kept.
   */
  fun rate(history: String): Float {
    if (history.isEmpty()) return 0f
    val kept = history.count { it == '1' }
    return kept.toFloat() / history.length.toFloat()
  }

  /**
   * `86%` — floored, and 100 reserved for a genuinely unbroken record.
   *
   * The same rule as `formatRate` in `src/features/habits/rate.ts`, and for the
   * same reason: a habit with a missed day that rounds up to a full score is the
   * one number on this face that would be a lie.
   */
  fun label(history: String): String {
    if (history.isEmpty()) return "—"
    val kept = history.count { it == '1' }
    if (kept >= history.length) return "100%"
    return "${(kept * 100) / history.length}%"
  }
}
