package ai.dby.ridik.widgets

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF

/**
 * The four drawings `RemoteViews` cannot make, rastered into alpha masks.
 *
 * The family's other faces are built from one primitive — a rounded rectangle at
 * radius 2 — precisely so nothing is drawn at runtime: every cell is a
 * `@drawable/` reference the launcher resolves in its own process. Four of the
 * expressive faces cannot be. `RemoteViews` cannot set a view's width or height
 * before API 31 (this app ships to 26), cannot draw a curve at all, and cannot
 * hold three hundred and sixty-five views without the binder transaction dying.
 * So Sundial's arc, Horizon's skyline, Route's segments and Term's dot field are
 * each one `setImageViewBitmap`.
 *
 * ## Everything here is a white alpha mask, and never a colour
 *
 * The same trap `RidikRings` is arranged around and `AGENTS.md` records for
 * text: **a colour resolved here is resolved in the wrong process.**
 * `resources.getColor()` inside a provider answers against the *app's*
 * configuration; the launcher draws the tile against its own. Flip the system to
 * dark with the app last opened in light and a runtime-coloured drawing is
 * painted near-black onto a near-black tile.
 *
 * So nothing computes a colour. Each drawing is white on transparent and the
 * `ImageView` carries `android:tint="@color/ridik_widget_heat_3"` — a colour
 * *reference*, which the launcher resolves against its own light/dark exactly as
 * it does for every cell on every other face.
 *
 * ## What that costs, and why it is the right trade here
 *
 * One tint is one hue, so the four heat levels become four **alphas** rather
 * than four colours. On the shipped strip that would be a loss: `mid` is a
 * specific ink and the whole point is that a `mid` cell means the same thing on
 * every tile. On these four it is not, because on all four the encoding is
 * *position or height*, not hue — where the sun is, how tall the block is, where
 * the puck sits, how many dots are behind you. §8's objection to a second
 * encoding of one variable is the reason these are alternatives to Today rather
 * than companions to it, and it is stated on each face.
 */
internal object RidikPlots {

  /**
   * The four levels as opacities.
   *
   * `cold` is deliberately visible rather than absent: a day with nothing on it
   * still has to draw, or the empty state would be a blank tile instead of the
   * same drawing with nothing lit — §4, and the rule the whole family is built
   * on.
   */
  private val ALPHA = intArrayOf(46, 92, 168, 255)

  /** What is left of a cell that is behind you. Matches `HeatCell.spentHeight`. */
  private const val SPENT = 0.38f

  private fun alphaOf(level: Char) = ALPHA[(level - '0').coerceIn(0, 3)]

  private fun mask(width: Int, height: Int): Pair<Bitmap, Canvas> {
    val bitmap = Bitmap.createBitmap(
      width.coerceAtLeast(1),
      height.coerceAtLeast(1),
      Bitmap.Config.ARGB_8888,
    )
    return bitmap to Canvas(bitmap)
  }

  private fun paint() = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }

  /* ---------------------------------------------------------------- skyline */

  /**
   * Horizon: the same cells as the day strip, but their height is their level.
   *
   * A flat strip tells you *when* you are busy; a silhouette tells you *how*
   * busy, because height is read pre-attentively where four opacities are not.
   * Burn-down still marks now — a spent block keeps its height and drops to the
   * same 38% the strip's cells do, so the step at `now` survives and the face
   * can still show that it is stale.
   */
  fun skyline(width: Int, height: Int, load: String, breaks: String, spentThrough: Int): Bitmap {
    val (bitmap, canvas) = mask(width, height)
    if (load.isEmpty()) return bitmap
    val paint = paint()
    val gap = 1.5f
    val step = width.toFloat() / load.length
    // The floor is what stops a clear day being an invisible tile: a level-0
    // block is a thin plinth rather than nothing at all.
    val floor = height * 0.12f

    for (index in load.indices) {
      val level = (load[index] - '0').coerceIn(0, 3)
      val spent = index <= spentThrough
      val full = floor + (height - floor) * (level / 3f)
      val tall = if (spent) full * SPENT else full
      paint.alpha = if (spent) (alphaOf(load[index]) * 0.55f).toInt() else alphaOf(load[index])
      val left = index * step
      // A break is a 2pt gap like any other boundary — the same mark the strip
      // makes, so the two faces agree about where a block ends.
      val right = left + step - if (breaks.getOrNull(index) == '1') gap * 2 else gap
      canvas.drawRoundRect(
        RectF(left, height - tall, right.coerceAtLeast(left + 1f), height.toFloat()),
        2f,
        2f,
        paint,
      )
    }
    return bitmap
  }

  /* ---------------------------------------------------------------- sundial */

  /**
   * Sundial: the day's cells laid on a curve, with a disc riding it at `now`.
   *
   * The amendment this face needs is one sentence and it is written into §1: *a
   * path carrying a position marker is permitted; a closed ring encoding a
   * fraction is not*. The distinction is real rather than a loophole — a
   * progress ring says "62% of a goal" and invites you to compare two of them;
   * this says "you are here, between these two ends", which is what the strip's
   * burn-down step already says, drawn so it can be read across a room.
   *
   * The curve is a **quadratic** with its control point at the horizontal
   * midpoint, which is what makes `x(t) = x0 + t·(x1 − x0)` exactly — so `t` is
   * the fraction of the day elapsed and no numeric inversion is needed. The same
   * arithmetic as `src/features/today/arc.ts`, deliberately, so the app screen
   * and the tile put the sun in the same place.
   */
  fun sundial(width: Int, height: Int, load: String, spentThrough: Int): Bitmap {
    val (bitmap, canvas) = mask(width, height)
    if (load.isEmpty()) return bitmap
    val paint = paint()
    val inset = width * 0.05f
    val x0 = inset
    val x1 = width - inset
    // Clamped against the step as well as the height, exactly like the dots.
    // The disc is a sun riding the arc; sized from the box alone it grows with
    // any tile that is taller than it is dense, and past about one step wide it
    // stops being a marker and becomes a blot covering the hours it sits on.
    val discR = minOf(height * 0.13f, (width.toFloat() / load.length) * 0.95f)
    // Clamped against the *step* and not only against the height. Thirty-two
    // dots across a medium tile is about 6.5dp each, and a dot sized purely
    // from a 76dp arc is 8.4dp across — so they overlapped into a caterpillar,
    // and a dot means nothing once it touches its neighbour.
    val dotR = minOf(height * 0.055f, (width.toFloat() / load.length) * 0.38f)
    // Room for the disc at either end of the sweep, top and bottom.
    val yBase = height - discR - 2f
    val yPeak = discR + 2f

    fun pointAt(t: Float): Pair<Float, Float> {
      val u = 1 - t
      // Control point at the horizontal midpoint, lifted to twice the height the
      // curve should reach: a quadratic passes at half the control's offset.
      val cy = yBase - (yBase - yPeak) * 2f
      return (x0 + t * (x1 - x0)) to (u * u * yBase + 2 * u * t * cy + t * t * yBase)
    }

    // The track, drawn first and faintly, so a day with nothing on it is still
    // a drawing rather than a blank tile.
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 1.5f
    paint.alpha = ALPHA[0]
    val path = Path()
    for (step in 0..64) {
      val (px, py) = pointAt(step / 64f)
      if (step == 0) path.moveTo(px, py) else path.lineTo(px, py)
    }
    canvas.drawPath(path, paint)

    paint.style = Paint.Style.FILL
    for (index in load.indices) {
      // The centre of the cell rather than its edge: a dot marks a span, and
      // putting it on the boundary reads as half an hour early all day.
      val t = (index + 0.5f) / load.length
      val (px, py) = pointAt(t)
      val spent = index <= spentThrough
      // Behind you the dots *shrink* rather than burn down — there is no
      // baseline on a curve for a cell to burn towards.
      val r = if (spent) dotR * 0.55f else dotR
      paint.alpha = if (spent) (alphaOf(load[index]) * 0.55f).toInt() else alphaOf(load[index])
      canvas.drawCircle(px, py, r, paint)
    }

    // The disc is the tile's one hot object, so §1.1 still holds.
    if (spentThrough in load.indices) {
      val (px, py) = pointAt((spentThrough + 1f) / load.length)
      paint.alpha = 255
      canvas.drawCircle(px, py, discR, paint)
    }
    return bitmap
  }

  /* ------------------------------------------------------------------ route */

  /**
   * Route: the day as a line, its events as segments, and now as a puck.
   *
   * Transit's lock-screen widget, transferred directly. Spent segments thin
   * behind you rather than burning down, because a horizontal line has no
   * baseline to burn towards — the same substitution Sundial makes.
   *
   * It is honest about position and not about duration: a puck wide enough to
   * see is about twenty-five minutes of a day, so it reads as *where you are*
   * and never as *how long this takes*. That is stated here because it is the
   * one thing about this face that could be mistaken for a measurement.
   */
  fun route(width: Int, height: Int, load: String, breaks: String, spentThrough: Int): Bitmap {
    val (bitmap, canvas) = mask(width, height)
    if (load.isEmpty()) return bitmap
    val paint = paint()
    val step = width.toFloat() / load.length
    // 27%, not 34%. The box grew from 30 dp to 44 so the caption would stop
    // being pushed to the floor by a hole, and 34% of 44 is a band rather than a
    // line. Expressed as a ratio rather than a dp cap because nothing in this
    // file knows the density — the bitmap arrives in pixels. `RouteLine` uses
    // the same 0.27 against the same box, which is what keeps the two identical.
    val thick = height * 0.27f
    val thin = thick * 0.42f
    // Clamped against the segment step: Transit's puck is a marker sitting on a
    // line, and it stops being one the moment it is wider than a few segments —
    // past that it is a blot covering the part of the day it points at.
    val puckR = minOf(height * 0.5f, step * 1.6f)
    val mid = height / 2f

    // **The line is continuous, and the rounding is on its ends.**
    //
    // Every segment used to be its own rounded rectangle with a hairline of
    // ground after it, and at thirty-two segments across a tile that is ten
    // units wide by nine tall with a four-unit radius — which is a circle. The
    // face drew as a row of beads rather than as a route, which is the whole
    // metaphor gone. So the segments butt against each other, a gap is left only
    // where a booking actually begins, and the *rail* is what carries the
    // rounded caps: clipped once, here, rather than thirty-two times.
    canvas.save()
    val rail = Path().apply {
      addRoundRect(
        RectF(0f, mid - thick / 2f, width.toFloat(), mid + thick / 2f),
        thick / 2f,
        thick / 2f,
        Path.Direction.CW,
      )
    }
    canvas.clipPath(rail)

    // **The track, and why "continuous" needed it to exist.**
    //
    // "Continuous" was a claim about the *clip*, not about what got drawn into
    // it, and for the first half of every day it was false on both platforms. An
    // empty cell is level 0, which is 18% of the accent; a *spent* one is that
    // times 0.55, which is ten. Ten per cent of an ember, four dp tall, is
    // nothing — so the whole morning of an ordinary day rendered as blank ground
    // and the route began at the puck. The face read as a slider someone had
    // dragged, which is the one thing it must not: a journey with no road behind
    // you. Burn-down cannot answer it the way it does on Skyline, because that
    // face has a baseline to shrink towards and a line has none. So the road is
    // laid first, full width, and the day is drawn on top. `RouteLine` lays the
    // same track at the same alpha.
    paint.alpha = (0.13f * 255).toInt()
    canvas.drawRect(RectF(0f, mid - thick / 2f, width.toFloat(), mid + thick / 2f), paint)

    for (index in load.indices) {
      val spent = index <= spentThrough
      val half = (if (spent) thin else thick) / 2f
      paint.alpha = if (spent) (alphaOf(load[index]) * 0.55f).toInt() else alphaOf(load[index])
      val left = index * step
      // No gap between two cells of the same booking — only where one starts.
      val right = left + step - if (breaks.getOrNull(index) == '1') 2.5f else 0f
      canvas.drawRect(
        RectF(left, mid - half, right.coerceAtLeast(left + 1f), mid + half),
        paint,
      )
    }
    canvas.restore()

    if (spentThrough in load.indices) {
      paint.alpha = 255
      val px = ((spentThrough + 1f) / load.length) * width
      // Clamped inside the bitmap: a puck at the last cell would be half
      // outside it and read as a clipped rectangle rather than a marker.
      canvas.drawCircle(px.coerceIn(puckR, width - puckR), mid, puckR, paint)
    }
    return bitmap
  }

  /* ------------------------------------------------------------------- dots */

  /**
   * Term: one dot per day, and the ones behind you burned down.
   *
   * Lifted almost whole from *one year*, and the only one of the four that needs
   * no amendment at all — a dot is the cell at its smallest, burn-down is
   * already the rule for what is past, and today is the one hot one.
   *
   * `elapsed` is the number of days *completed*, so `elapsed` is also the index
   * of today. Nothing here reads the day's load: this face is a count of days,
   * not a measure of them, which is exactly what lets it sit beside Sundial
   * without the two arguing about what a cell means.
   */
  fun dots(width: Int, height: Int, total: Int, elapsed: Int, columns: Int): Bitmap {
    val (bitmap, canvas) = mask(width, height)
    if (total <= 0 || columns <= 0) return bitmap
    val paint = paint()
    val rows = (total + columns - 1) / columns
    val cellW = width.toFloat() / columns
    val cellH = height.toFloat() / rows
    // The smaller axis, so a wide short tile does not draw ellipses.
    val r = (minOf(cellW, cellH) / 2f - 0.6f).coerceAtLeast(0.6f)

    for (index in 0 until total) {
      val cx = (index % columns) * cellW + cellW / 2f
      val cy = (index / columns) * cellH + cellH / 2f
      // Every dot is drawn at full size, and only the alpha moves.
      //
      // §1.3's burn-down is a *height* rule and there is no height here to take
      // 38% of — a dot has one dimension, so shrinking it takes the ink away in
      // both axes at once. Drawn that way the 241 days behind you read as a
      // faint speckle under 124 solid ones ahead: the past looked *less* present
      // than the future, which is the opposite of what the face is for. So the
      // history is the filled mass, today is the one hot dot, and the days still
      // to come are the faint tail — which is how `one year`, the app this is
      // lifted from, draws it.
      paint.alpha = when {
        index < elapsed -> 128
        index == elapsed -> 255
        else -> ALPHA[0]
      }
      canvas.drawCircle(cx, cy, r, paint)
    }
    return bitmap
  }
}
