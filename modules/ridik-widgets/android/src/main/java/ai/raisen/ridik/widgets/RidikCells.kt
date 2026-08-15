package ai.raisen.ridik.widgets

import android.content.Context
import android.os.SystemClock
import android.text.SpannableString
import android.text.Spanned
import android.text.format.DateFormat
import android.text.style.StrikethroughSpan
import android.view.View
import android.widget.RemoteViews
import java.text.NumberFormat
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.text.DateFormat as TimeFormat

/**
 * The drawing vocabulary the five Android faces share.
 *
 * Every graphic in the family is one primitive: a cell, filled with the single
 * ember colour at one of four opacities. A whole visualisation therefore travels
 * as a string of digits and arrives here as a fold over it — which is the only
 * reason a widget with 210 of them can be drawn without a bitmap.
 *
 * Three invariants live in this file, and breaking any of them breaks the family:
 *
 *  1. **`hot` marks today, and only today, in one place per tile.** The habit
 *     rails are the single exemption: their hot cells are the *last column*, and
 *     a column is one thing however many rails it crosses. The only tile with
 *     two candidates is Calendar large, and §3.2 names the winner — **the
 *     element takes it and the plate does not**: the element's hot cell is the
 *     next thing, which is actionable, and the plate's is today, which the
 *     reader already knows. Today on the plate keeps its ring and draws at its
 *     own load level, which is also the only way that ring is visible at all in
 *     light mode, where the ring colour and the hot fill are both `#C7360F`.
 *  2. **Ink never sits on hot.** The only ink over a cell in this family is the
 *     plate's numeral, and it inverts to `on_heat` there and only there.
 *  3. **Past cells burn down** — same level, 38% height, bottom-aligned. The
 *     step in the silhouette *is* the now-marker. There is no playhead line, and
 *     that is what lets a face survive Android's thirty-minute update period: a
 *     boundary twenty minutes stale looks fine, a labelled rule twenty minutes
 *     stale looks broken.
 *
 * "Now" is always this process's own clock read in the payload's zone. Never
 * `publishedAt`, which is when the *app* last ran, and never the device's zone,
 * which is right until the user is travelling.
 */

/**
 * Android has no widget families, so the size is read back from the launcher.
 *
 * `WIDGETS.md` §2: under 250dp wide is small, wider than that but under 170dp
 * tall is medium, and anything else is large. RemoteViews cannot set a width, a
 * height or a column count at runtime, so each of the three is a separate
 * generated layout and this is what picks between them.
 */
internal enum class WidgetSize { SMALL, MEDIUM, LARGE }

private const val MEDIUM_MIN_DP = 250
private const val LARGE_MIN_DP = 170

/**
 * A launcher that reports nothing gets medium.
 *
 * `getAppWidgetOptions` returns an empty bundle for a widget that has never been
 * resized on some launchers, and zero is not "small" — it is "unknown". Medium
 * is the shape the provider XML asks for, so it is the honest guess.
 */
internal fun sizeOf(widthDp: Int, heightDp: Int): WidgetSize = when {
  widthDp <= 0 -> WidgetSize.MEDIUM
  widthDp < MEDIUM_MIN_DP -> WidgetSize.SMALL
  heightDp <= 0 || heightDp < LARGE_MIN_DP -> WidgetSize.MEDIUM
  else -> WidgetSize.LARGE
}

/**
 * The habit board's size comes from its WIDTH alone.
 *
 * `sizeOf` promotes a tile to LARGE on height, which is right for a face that
 * gains rows when it gets taller. A rail board does not: it gains *columns*
 * when it gets wider, and height only ever buys air. Sizing it the general way
 * gave a tall narrow tile thirty-five columns and a forty-dp gutter, so every
 * name on the board ellipsised to "Readi…" and the cells became hairlines.
 *
 * Wider buys days. Narrower buys back the gutter. Nothing buys fatter cells.
 */
internal fun railSizeOf(widthDp: Int): WidgetSize = when {
  widthDp <= 0 -> WidgetSize.MEDIUM
  widthDp < RAILS_MEDIUM_DP -> WidgetSize.SMALL
  widthDp < RAILS_LARGE_DP -> WidgetSize.MEDIUM
  else -> WidgetSize.LARGE
}

/** Below this a 21-day board cannot hold a name and a legible cell at once. */
private const val RAILS_MEDIUM_DP = 260

/** Above this there is room for five weeks without the cells becoming hairlines. */
private const val RAILS_LARGE_DP = 360

/**
 * How many slots each generated layout actually has.
 *
 * The twin of this is the geometry block in `plugins/withRidikAndroidWidget.js`.
 * Nothing checks that they agree: an id the layout does not contain resolves to
 * 0, every action against it is dropped in silence, and the widget renders a
 * short graphic that looks deliberate.
 */
internal object Slots {
  /** Rail slots are fixed at six whatever the size — a board occupies its rectangle. */
  const val RAILS = 6

  /** Six weeks of seven: a 31-day month that starts on a Sunday needs all six. */
  const val PLATE = 42

  fun day(size: WidgetSize) = if (size == WidgetSize.SMALL) 8 else 32

  fun railDays(size: WidgetSize) = when (size) {
    WidgetSize.SMALL -> 7
    WidgetSize.MEDIUM -> 21
    WidgetSize.LARGE -> 35
  }

  fun debt(size: WidgetSize) = if (size == WidgetSize.SMALL) 12 else 24

  fun rows(size: WidgetSize) = if (size == WidgetSize.SMALL) 4 else 6
}

/**
 * Every resource the faces reach for, resolved by name.
 *
 * The widget's resources are written into the *app* module by
 * `plugins/withRidikAndroidWidget.js`, and an Android library cannot see the
 * app's `R` — the dependency only points the other way. So they are looked up as
 * strings, and `IDS` in that plugin is the other end of this list. Rename one
 * without the other and the build stays green while the widget renders blank.
 *
 * Nothing can strip them out from under this: the manifest names each provider
 * XML, the provider XML names the layout, and `raw/ridik_widget_keep.xml` covers
 * everything reached only from here.
 */
internal class WidgetIds(context: Context, layoutName: String) {
  private val resources = context.resources
  private val pkg = context.packageName

  /** 0 when the layout is missing, which means there is nothing to draw at all. */
  val layout = resources.getIdentifier(layoutName, "layout", pkg)

  val body = id("ridik_body")
  val notice = id("ridik_notice")
  val noticeTitle = id("ridik_notice_title")
  val noticeBody = id("ridik_notice_body")
  val eyebrow = id("ridik_eyebrow")
  val count = id("ridik_count")
  val headline = id("ridik_headline")
  val sub = id("ridik_sub")
  val allDay = id("ridik_allday")
  val next = id("ridik_next")
  val readout = id("ridik_readout")
  val nextTitle = id("ridik_next_title")
  val nextSub = id("ridik_next_sub")
  val timer = id("ridik_timer")
  val dayArea = id("ridik_day_area")
  val plateArea = id("ridik_plate_area")
  val railArea = id("ridik_rail_area")
  val debtArea = id("ridik_debt_area")
  val rowArea = id("ridik_rows")
  val footLeft = id("ridik_foot_left")
  val footRight = id("ridik_foot_right")

  fun id(name: String) = resources.getIdentifier(name, "id", pkg)

  /**
   * One drawable per heat level, and a second set for the cell that is today.
   *
   * The ring is a separate drawable rather than a second view because a plate
   * cell is 17dp across: a ring drawn as an overlay would need a `FrameLayout`
   * per day, and forty-two of those is a third of the tile's whole view budget.
   *
   * Resolved once and cached, because the habits board asks for one of these
   * two hundred and ten times in a single draw and `getIdentifier` is a search
   * through the resource table, not a lookup.
   */
  fun heat(level: Int, today: Boolean = false): Int {
    val slot = level.coerceIn(0, 3) + if (today) 4 else 0
    if (heatIds[slot] == 0) {
      val name = "ridik_heat_${slot % 4}" + if (today) "_today" else ""
      heatIds[slot] = resources.getIdentifier(name, "drawable", pkg)
    }
    return heatIds[slot]
  }

  private val heatIds = IntArray(8)

  /**
   * Resolved rather than themed: `setTextColor` takes an int, and the launcher
   * replays these in its own process where a colour *resource* would be looked
   * up against the launcher's resources, not ours.
   */
  fun colour(name: String): Int {
    val id = resources.getIdentifier(name, "color", pkg)
    if (id == 0) return 0
    return resources.getColor(id, null)
  }

  val ink by lazy { colour("ridik_widget_ink") }
  val inkSoft by lazy { colour("ridik_widget_ink_soft") }
  val onHeat by lazy { colour("ridik_widget_on_heat") }
}

/* ------------------------------------------------------------------- the frame */

/**
 * A view with nothing to say is removed, not left holding an empty string.
 *
 * RemoteViews are rebuilt from scratch on every update, so a view this never
 * touches keeps whatever the XML gave it — which is why the layouts ship every
 * optional line already `gone` and this is the only thing that reveals one.
 */
internal fun RemoteViews.line(id: Int, text: CharSequence?) {
  if (id == 0) return
  if (text.isNullOrEmpty()) {
    setViewVisibility(id, View.GONE)
    return
  }
  setViewVisibility(id, View.VISIBLE)
  setTextViewText(id, text)
}

/** `setBackgroundResource` is `@RemotableViewMethod`; a drawable id is all it takes. */
internal fun RemoteViews.background(id: Int, drawable: Int) {
  if (id == 0 || drawable == 0) return
  setInt(id, "setBackgroundResource", drawable)
}

/**
 * The whole-tile message, for the two states where drawing anything would lie.
 *
 * Only "nothing published" and "wrong version" come through here. Every other
 * empty state still draws its graphic — cold cells, all slots present — with the
 * copy underneath it, because a frame that is a bare sentence on a flat
 * rectangle is the one shape this family does not have.
 *
 * **A stale day face is not one of the two.** Android redraws at most every
 * thirty minutes, so from local midnight until the app is next opened this is
 * what every tile on the home screen would be: routing "Yesterday's plan."
 * through here blanks five widgets every morning. It goes under the drawing
 * instead — see `say` — with the strip burned down and the counts suppressed.
 */
internal fun RemoteViews.notice(ids: WidgetIds, title: String, body: String) {
  setViewVisibility(ids.body, View.GONE)
  setViewVisibility(ids.notice, View.VISIBLE)
  setTextViewText(ids.noticeTitle, title)
  setTextViewText(ids.noticeBody, body)
}

internal fun RemoteViews.showBody(ids: WidgetIds) {
  setViewVisibility(ids.notice, View.GONE)
  setViewVisibility(ids.body, View.VISIBLE)
}

/** The eyebrow and the one number beside it. Never two numbers — see §3.1. */
internal fun RemoteViews.head(ids: WidgetIds, eyebrow: String, count: String?) {
  setTextViewText(ids.eyebrow, eyebrow)
  line(ids.count, count)
}

/** The empty-state copy that sits under a graphic rather than replacing it. */
internal fun RemoteViews.say(ids: WidgetIds, headline: String?, sub: String?) {
  line(ids.headline, headline)
  line(ids.sub, sub)
}

internal fun struck(text: String): CharSequence {
  val span = SpannableString(text)
  span.setSpan(StrikethroughSpan(), 0, text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
  return span
}

/* ------------------------------------------------------------------ the clock */

/**
 * The payload's zone, never the device's.
 *
 * They agree at home and differ by hours the moment the user is travelling — and
 * a day face wrong by hours looks entirely plausible, which is what makes it
 * worth carrying a field for.
 */
internal fun zoneOf(snapshot: WidgetSnapshot): ZoneId =
  runCatching { ZoneId.of(snapshot.zone) }.getOrElse { ZoneId.systemDefault() }

/** Minutes past local midnight, from this process's own clock. */
internal fun minutesOf(now: ZonedDateTime): Int = now.hour * 60 + now.minute

/**
 * The minute a day that has already ended is read at.
 *
 * Every cell of the strip is behind it, so the whole element burns down to 38%
 * — which is what a spent day looks like, and is the drawing a stale face shows
 * with "Yesterday's plan." underneath rather than instead of it.
 */
internal fun endOfDay(day: WidgetDay, slots: Int): Int {
  val cells = if (day.load.isEmpty()) slots else day.load.length
  return day.startMinute + cells * day.cellMinutes
}

/**
 * The day the payload describes, which is today only while it is fresh.
 *
 * The rails end on it and the header names it, so a stale face labels the day it
 * is actually drawing rather than the one the reader is standing in.
 */
internal fun describedDate(snapshot: WidgetSnapshot, zone: ZoneId): LocalDate =
  runCatching { LocalDate.parse(snapshot.day.date) }.getOrElse { LocalDate.now(zone) }

/** "THU 13" — the reader's own locale, upper-cased by the label's own rule. */
internal fun dayLabel(date: LocalDate): String =
  date.format(DateTimeFormatter.ofPattern("EEE d", Locale.getDefault()))
    .uppercase(Locale.getDefault())

/**
 * The device's 12/24-hour setting, read in the *payload's* zone.
 *
 * `DateFormat.getTimeFormat` hands back a formatter bound to
 * `TimeZone.getDefault()`. Fly London to New York without opening Ridik and
 * every row lead on the tile would shift by five hours while the strip beside
 * them, the axis under them and the header above them all stayed in the zone the
 * day was computed in — a 15:00 meeting printed as "10:00" beside a hot cell at
 * the 15:00 mark. One field on a fresh formatter is the whole fix.
 */
internal fun timeFormat(context: Context, zone: ZoneId): TimeFormat {
  val format = DateFormat.getTimeFormat(context)
  format.timeZone = TimeZone.getTimeZone(zone)
  return format
}

/** An em dash for a time that is not there, which is not the same as midnight. */
internal fun TimeFormat.clock(epochMillis: Long?): String =
  if (epochMillis == null || epochMillis <= 0L) "—" else format(Date(epochMillis))

/**
 * Whether the strip and the rows still describe the day the reader is standing
 * in — asked of `day.date` and not of `publishedAt`.
 *
 * `publishedAt` is when the *app* last ran, which is a different question: a
 * snapshot published at 23:58 is still today's plan at 00:02 by that measure,
 * and is not.
 */
internal fun describesToday(snapshot: WidgetSnapshot, zone: ZoneId): Boolean =
  snapshot.day.date.isNotEmpty() && snapshot.day.date == LocalDate.now(zone).toString()

/**
 * The plate outlives the day: it is stale only once the month itself turns over.
 *
 * A payload carrying no month at all is *empty*, not stale — `plate` falls back
 * to drawing this month cold, which is the honest picture of a calendar nobody
 * has told Ridik about, and "Last month's plate." over it would be the one lie
 * on the tile.
 */
internal fun describesThisMonth(snapshot: WidgetSnapshot, zone: ZoneId): Boolean =
  snapshot.month.month.isEmpty() || snapshot.month.month == YearMonth.now(zone).toString()

/**
 * How much of the rest of the day has nothing in it.
 *
 * Counted from the device's own clock and never from `freeMinutes`, which is the
 * whole window and would still cheerfully say "15h" at nine in the evening.
 * Quantised to the quarter hour: the reader is deciding whether an afternoon is
 * worth booking, not counting minutes, and "4h 47m" reads as machine noise.
 */
internal fun unclaimedMinutes(day: WidgetDay, nowMinutes: Int): Int {
  var minutes = 0
  for (index in day.load.indices) {
    if (day.load[index] != '0') continue
    val start = day.startMinute + index * day.cellMinutes
    val end = start + day.cellMinutes
    if (end <= nowMinutes) continue
    minutes += end - maxOf(start, nowMinutes)
  }
  return (minutes / 15) * 15
}

internal fun spanText(minutes: Int): String {
  val hours = minutes / 60
  val rest = minutes % 60
  return when {
    hours <= 0 -> "${rest}m"
    rest == 0 -> "${hours}h"
    else -> "${hours}h ${rest}m"
  }
}

/**
 * "All 6, today." — the numeral, on both platforms.
 *
 * This was an array of thirteen English words that fell back to a digit past
 * twelve, so one sentence ended in a word or in a numeral depending on how much
 * shopping there was — and said "twelve" to a reader whose phone is not in
 * English. Spelling out properly is `NumberFormatter.spellOut` on iOS and
 * `RuleBasedNumberFormat` on Android, and **Android does not expose RBNF**:
 * `android.icu.text` ships the formatters and not the rule sets. The only
 * thing left that both platforms can do in every language is the digit.
 *
 * Localised rather than `toString`, because a device set to Arabic or Bengali
 * numbers the rest of its widget in its own digits and this sentence should
 * not be the one that reverts to Latin ones.
 */
internal fun number(count: Int): String =
  runCatching { NumberFormat.getIntegerInstance(Locale.getDefault()).format(count.toLong()) }
    .getOrElse { count.toString() }

/* ---------------------------------------------------------------- the element */

/**
 * The day, drawn cell by cell, with its ruler under it.
 *
 * `slots` is how many cells the inflated layout actually has: 32 at medium and
 * large, 8 at small — where the same strip is bucketed rather than re-windowed,
 * because the axis labels have to keep reading 07 / 11 / 15 / 19 / 23. A bucket
 * takes the *maximum* of its cells and is spent only when all of them are.
 *
 * Only the cells that differ from cold cost an action. The XML ships every one
 * of them cold, full height and unpadded, so a typical day touches about a third
 * of the strip and the parcel stays small.
 *
 * The strip keeps the tile's hot cell wherever it is drawn, including on
 * Calendar large: the next thing is the actionable candidate and today's date on
 * the plate is not, so the plate is the one that yields — see `plate`.
 */
internal fun RemoteViews.element(
  context: Context,
  ids: WidgetIds,
  day: WidgetDay,
  slots: Int,
  nowMinutes: Int,
) {
  // An empty load is a cold day and not a missing strip: every empty state in
  // this family still draws its graphic.
  val load = if (day.load.isEmpty()) "0".repeat(slots) else day.load
  val breaks = day.breaks.padEnd(load.length, '0')
  val used = minOf(slots, load.length)
  // The 2dp of ground before a new booking is padding on the cell rather than a
  // spacer view: `setViewPadding` is the one geometry call RemoteViews has, and
  // 31 spacers would have cost more views than the rest of the tile.
  val gap = (2f * context.resources.displayMetrics.density).toInt().coerceAtLeast(1)

  for (slot in 0 until slots) {
    val cell = ids.id("ridik_cell_$slot")
    val full = ids.id("ridik_cell_${slot}_full")
    val burned = ids.id("ridik_cell_${slot}_spent")
    if (slot >= used) {
      // A shorter waking window leaves slots over. GONE rather than INVISIBLE:
      // this strip is one row, so dropping a cell widens the rest, which is
      // exactly right — unlike the plate, where it would deform the grid.
      setViewVisibility(cell, View.GONE)
      continue
    }

    val from = slot * load.length / used
    val to = maxOf(from + 1, (slot + 1) * load.length / used)
    var level = 0
    var spent = true
    for (index in from until to) {
      level = maxOf(level, load[index] - '0')
      if (day.startMinute + (index + 1) * day.cellMinutes > nowMinutes) spent = false
    }

    // Every cell is stated, every time, including the cold ones. A widget is
    // *reapplied* onto the view it drew last time whenever the layout id has
    // not changed, so "leave it and it keeps what the XML gave it" is only
    // true of the first draw: skipping the cold cells left yesterday evening's
    // strip fully burned down at nine the next morning, and skipping the full
    // ones left last night's meeting lit on an empty day.
    setViewVisibility(cell, View.VISIBLE)
    setViewVisibility(full, if (spent) View.GONE else View.VISIBLE)
    setViewVisibility(burned, if (spent) View.VISIBLE else View.GONE)
    background(if (spent) burned else full, ids.heat(level))
    setViewPadding(cell, if (slot > 0 && breaks[from] == '1') gap else 0, 0, 0, 0)
  }

  // The ruler is written at draw time and never baked in: the waking window is a
  // Settings value, and a strip that started at 06:00 under a label reading 07
  // would be wrong by an hour and look perfectly fine.
  val span = load.length * day.cellMinutes
  for (mark in 0 until 5) {
    val minute = day.startMinute + mark * span / 4
    setTextViewText(ids.id("ridik_axis_$mark"), String.format(Locale.US, "%02d", (minute / 60) % 24))
  }

  setContentDescription(ids.dayArea, dayDescription(day, nowMinutes))
}

/** "4h 30m free from now" — the strip has no words, so TalkBack is given some. */
private fun dayDescription(day: WidgetDay, nowMinutes: Int): String {
  val free = unclaimedMinutes(day, nowMinutes)
  return "Today: ${spanText(free)} unclaimed from now"
}

/* ------------------------------------------------------------------ the plate */

/**
 * The month, one cell per day.
 *
 * Out-of-month cells are hidden `INVISIBLE` and never `GONE`: a `GONE` child is
 * dropped from `LinearLayout` weight distribution, so the first and last weeks
 * would get visibly wider columns than the four between them. `GONE` is correct
 * only for an entirely unused sixth row, which is the one case where nothing is
 * left to line up with.
 *
 * **The day of the month is recomputed here, on the device.** Only `month.load`
 * is inherited: `month.today` is a publish-time number and is stale the moment
 * the day turns, and trusting it hot-fills the 5th on the 13th — on the one face
 * that is supposed to survive a week untouched.
 *
 * `allowHot` is spent by the element wherever there is one, so it is true on
 * small and false on large. Today keeps its ring either way, and on large that
 * ring is the only thing marking it: `ridik_widget_ember` and `heat_3` are both
 * `#C7360F` in light mode, so a ring around a hot fill is invisible.
 */
internal fun RemoteViews.plate(
  ids: WidgetIds,
  month: WidgetMonth,
  zone: ZoneId,
  numerals: Boolean,
  allowHot: Boolean,
) {
  val target = runCatching { YearMonth.parse(month.month) }.getOrElse { YearMonth.now(zone) }
  val days = target.lengthOfMonth()
  val weekStart = month.weekStartsOn.coerceIn(1, 7)
  // Stepped from the 1st's weekday rather than from a running date, because a
  // month containing a DST switch has a 23- or 25-hour day in it.
  val offset = Math.floorMod(target.atDay(1).dayOfWeek.value - weekStart, 7)
  // 0 when this plate is not the current month, which is exactly what a plate a
  // month out of date should be marking: nothing.
  val todayNumber =
    if (target == YearMonth.now(zone)) LocalDate.now(zone).dayOfMonth else 0

  for (index in 0 until Slots.PLATE) {
    val id = ids.id("ridik_plate_$index")
    val number = index - offset + 1
    if (number < 1 || number > days) {
      setViewVisibility(id, View.INVISIBLE)
      // Cleared as well as hidden. A widget is *reapplied* onto the view it
      // drew last time whenever the layout id has not changed, so an action
      // this skips leaves the previous month's answer standing rather than the
      // XML's: the 31st drawn hot in March would still be hot in April, on the
      // face whose whole promise is to survive a week untouched.
      background(id, ids.heat(0))
      if (numerals) setTextViewText(id, "")
      continue
    }

    val today = number == todayNumber
    // The builder already guarantees the plate never sends '3'; today is the
    // only hot cell there is, and only when this tile has not spent it already.
    val level = if (today && allowHot) 3 else (month.load.getOrElse(number - 1) { '0' } - '0')
    setViewVisibility(id, View.VISIBLE)
    background(id, ids.heat(level, today))
    if (numerals) {
      setTextViewText(id, number.toString())
      // No `setTextColor` here, deliberately — the XML default is
      // `@color/ridik_widget_ink`, which the *launcher* resolves against its own
      // night mode. A runtime colour would be resolved in the app's process
      // instead, and the two disagree (see `colour` above). Ink never sits on
      // hot, and it does not have to: numerals are drawn only on large, where
      // today keeps its own load level and its ring rather than going hot.
    }
  }

  // The sixth week is kept, and kept INVISIBLE when it is unused, exactly like
  // an out-of-month cell. GONE dropped it from the weight distribution and the
  // five remaining rows grew to fill the gap — so a February plate had visibly
  // taller cells than an August one, on the same tile, and neither was the
  // size the plate is drawn at. The row occupies its ground and says nothing.
  setViewVisibility(
    ids.id("ridik_plate_week_5"),
    if (offset + days <= 35) View.INVISIBLE else View.VISIBLE,
  )

  // The letters over the columns, in the reader's own language and rotated to
  // the week the payload starts on. They were a baked "M T W T F S S", which is
  // an English Monday-first calendar printed over a plate that may be neither.
  for (column in 0 until 7) {
    val letter = DayOfWeek.of(Math.floorMod(weekStart - 1 + column, 7) + 1)
      .getDisplayName(TextStyle.NARROW, Locale.getDefault())
    setTextViewText(ids.id("ridik_wday_$column"), letter)
  }

  setContentDescription(
    ids.plateArea,
    if (todayNumber > 0) "${target.month.getDisplayName(TextStyle.FULL, Locale.getDefault())}, today is the $todayNumber"
    else target.month.getDisplayName(TextStyle.FULL, Locale.getDefault()),
  )
}

/* ------------------------------------------------------------------- the rails */

/**
 * Six habit rails, whether or not there are six habits.
 *
 * A board occupies its rectangle at zero habits and a list does not — the empty
 * slots teach the capacity without a word, which is why nothing here is ever
 * hidden. The names live in the gutter and never above the rail, because the
 * read this exists for ("everything dies on a Sunday") is a vertical one down
 * aligned columns and a name line between rails destroys it.
 *
 * Levels are binary: '0' is cold, '1' is claimed, and the last cell — today — is
 * hot when it is lit. If today is not done there is no hot cell on that rail,
 * and that absence is the message.
 *
 * `marksToday` is what withdraws the exemption on a stale board. The last column
 * of a snapshot published yesterday is yesterday, and lighting it would claim a
 * habit had been logged on a day that has not started yet; it keeps its own
 * level, which is still true of the day it actually stands for.
 */
internal fun RemoteViews.rails(
  ids: WidgetIds,
  rows: List<HabitRow>,
  days: Int,
  showBest: Boolean,
  showRuler: Boolean,
  today: LocalDate,
  marksToday: Boolean = true,
) {
  for (rail in 0 until Slots.RAILS) {
    val habit = rows.getOrNull(rail)
    setTextViewText(ids.id("ridik_habit_name_$rail"), habit?.name ?: "")
    // A streak of one is just "today" and not yet worth the word.
    setTextViewText(
      ids.id("ridik_habit_streak_$rail"),
      if (habit != null && habit.streak > 1) "${habit.streak}d" else "",
    )
    if (showBest) {
      setTextViewText(
        ids.id("ridik_habit_best_$rail"),
        if (habit != null && habit.longestStreak > 1) "best ${habit.longestStreak}" else "",
      )
    }

    val history = habit?.history.orEmpty()
    // The *last* N days of a 35-day string, so every window ends on today and
    // the six rails stay column-aligned with each other.
    val from = maxOf(0, history.length - days)
    for (column in 0 until days) {
      val index = from + column
      val lit = index < history.length && history[index] == '1'
      // Cold is drawn as deliberately as lit. The board is reapplied onto the
      // one it drew last time, so a cell left alone keeps the level it was
      // last given — a habit dropped after a good week would have gone on
      // showing that week for as long as the widget stayed put.
      val level = if (!lit) 0 else if (column == days - 1 && marksToday) 3 else 2
      background(ids.id("ridik_rail_${rail}_$column"), ids.heat(level))
    }

    setContentDescription(
      ids.id("ridik_rail_$rail"),
      if (habit == null) {
        // An empty slot is empty to TalkBack as well, and is *said* to be:
        // the description of the habit that used to be in it would otherwise
        // survive the habit itself.
        ""
      } else {
        "${habit.name}, ${if (habit.doneToday) "done today" else "not done today"}" +
          if (habit.streak > 1) ", ${habit.streak} day streak" else ""
      },
    )
  }

  // The ruler rotates: a window that ends on today has a different weekday in
  // column 0 every midnight, so a static M-to-S header would be right one day in
  // seven. Large has no ruler — 35 columns inside a phone widget is about 5dp
  // each, and a letter does not fit in 5dp.
  if (!showRuler) return
  for (column in 0 until days) {
    val date = today.minusDays((days - 1 - column).toLong())
    setTextViewText(
      ids.id("ridik_wday_$column"),
      date.dayOfWeek.getDisplayName(TextStyle.NARROW, Locale.getDefault()),
    )
  }
}

/* -------------------------------------------------------------------- the debt */

/**
 * One cell per open task, oldest left.
 *
 * The axis is age, not clock time. `due` in the tool contract is a full
 * `YYYY-MM-DDTHH:mm`, so the model invents an hour whenever the user did not say
 * one — plotting that as a position would render fiction as data. How late
 * something is was never guessed.
 *
 * Every slot is drawn, cold when there is no task for it: a row of cold cells is
 * a gauge reading zero, and hiding them would make an empty tile a different
 * shape from a full one.
 */
internal fun RemoteViews.debt(ids: WidgetIds, ages: List<Int>, slots: Int) {
  for (index in 0 until slots) {
    val age = ages.getOrNull(index)
    val level = when {
      // A slot with no task behind it is a cold detent of the gauge, and it is
      // *set* cold rather than left alone: the strip is reapplied onto the one
      // it drew last time, so a task that was ticked off would keep its cell
      // lit until the widget was next re-inflated.
      age == null -> 0
      // The single oldest overdue is the tile's one hot cell. `ages` arrives
      // oldest first, so it is always index 0 — and only when it is overdue at
      // all, or a day with nothing late would light up for no reason.
      index == 0 && age > 0 -> 3
      age <= 0 -> 0
      age <= 2 -> 1
      else -> 2
    }
    background(ids.id("ridik_debt_$index"), ids.heat(level))
  }
  setContentDescription(ids.debtArea, "${ages.size} open, oldest ${ages.firstOrNull() ?: 0} days")
}

/* -------------------------------------------------------------------- the rows */

/** One row as the faces draw it, whichever section it came from. */
internal data class FaceRow(
  val lead: String,
  val text: String,
  val trail: String?,
  /** Done or ticked off: struck through and dimmed. */
  val spent: Boolean = false,
  /** What TalkBack reads instead of "9 40, colon, Materials lab". */
  val spoken: String,
)

/**
 * `capacity` is how many rows fit in the height the launcher gave *this* copy of
 * the widget — the same face is two rows tall in one corner of the home screen
 * and six in another, and drawing six into the short one clips the last in half.
 */
internal fun RemoteViews.rowList(ids: WidgetIds, rows: List<FaceRow>, slots: Int) {
  for (slot in 0 until slots) {
    val row = ids.id("ridik_row_$slot")
    val item = rows.getOrNull(slot)
    if (item == null) {
      setViewVisibility(row, View.GONE)
      continue
    }
    setViewVisibility(row, View.VISIBLE)
    setTextViewText(ids.id("ridik_row_lead_$slot"), item.lead)
    rowText(ids, slot, item.text, soft = item.spent)
    line(ids.id("ridik_row_trail_$slot"), item.trail)
    setContentDescription(row, item.spoken)
  }
}

/**
 * The checklist's rows: a mark and the text, and no cells beyond the mark.
 *
 * A checklist has no time axis and inventing one would be decoration. One tile
 * without a graphic is what makes the other four read as chosen rather than as a
 * house style applied everywhere — the marks are still the family's primitive,
 * at its quietest.
 */
internal fun RemoteViews.tickList(ids: WidgetIds, rows: List<ListRow>, slots: Int) {
  for (slot in 0 until slots) {
    val row = ids.id("ridik_row_$slot")
    val item = rows.getOrNull(slot)
    if (item == null) {
      setViewVisibility(row, View.GONE)
      continue
    }
    setViewVisibility(row, View.VISIBLE)
    background(ids.id("ridik_tick_$slot"), ids.heat(if (item.done) 2 else 0))
    rowText(ids, slot, item.text, soft = item.done)
    setContentDescription(row, "${item.text}, ${if (item.done) "done" else "still open"}")
  }
}

/**
 * A column of cold marks: what the checklist looks like with no list in it.
 *
 * The marks are this face's whole graphic, so hiding them is what would make it
 * the one empty state in the family that is a bare sentence on a flat rectangle
 * — the shape §4 exists to forbid. Habits keeps its six rails for the same
 * reason: an empty board teaches the capacity without a word.
 */
internal fun RemoteViews.coldTicks(ids: WidgetIds, slots: Int) {
  // The largest any generated variant has. Clearing to the ceiling is safe on a
  // layout with fewer — an id the layout does not contain resolves to 0 and the
  // action is dropped — and under-clearing is what leaves stale words on screen.
  val MAX_ROW_SLOTS = 6
  for (slot in 0 until slots) {
    val row = ids.id("ridik_row_$slot")
    setViewVisibility(row, View.VISIBLE)
    background(ids.id("ridik_tick_$slot"), ids.heat(0))
    setTextViewText(ids.id("ridik_row_text_$slot"), "")
    // Empty of words as well as of items: TalkBack should find the sentence
    // under the marks, not four announcements of nothing.
    setContentDescription(row, "")
  }

  // Every slot past the cold ones is hidden explicitly. A RemoteViews update is
  // reapplied onto the view the widget last drew, so a row this branch never
  // touches keeps the text the previous draw put in it — an empty list with
  // yesterday's items still legible beside its cold marks.
  for (slot in slots until MAX_ROW_SLOTS) {
    setViewVisibility(ids.id("ridik_row_$slot"), View.GONE)
  }
}

/**
 * Which of a row's two text views is showing.
 *
 * Two, rather than one whose colour is set at draw time, because a colour
 * resolved here is resolved against the *app* process's configuration while the
 * launcher draws the tile against its own. Flip the system to dark with the app
 * last run in light and every runtime-coloured string is written in near-black
 * onto a near-black tile — which is exactly what it did: the ember and the
 * trailing text stayed correct, because those come from the layout's own
 * `@color/` references, and only the titles vanished.
 *
 * `setColorStateList` would fix it in one line and is API 31; this app ships to
 * 26. Two views in the layout costs six per face and is right everywhere.
 */
private fun RemoteViews.rowText(ids: WidgetIds, slot: Int, text: String, soft: Boolean) {
  // Written to both, and only one shown. Setting only the visible one leaves
  // the other holding whatever the previous draw put there, and a RemoteViews
  // update is reapplied onto the view the widget last drew.
  setTextViewText(ids.id("ridik_row_text_$slot"), text)
  setTextViewText(ids.id("ridik_row_soft_$slot"), struck(text))
  setViewVisibility(ids.id("ridik_row_text_$slot"), if (soft) View.GONE else View.VISIBLE)
  setViewVisibility(ids.id("ridik_row_soft_$slot"), if (soft) View.VISIBLE else View.GONE)
}

/* ------------------------------------------------------------------ the timer */

/**
 * "leave in 34 min", counted down by the platform.
 *
 * A `Chronometer` with `setChronometerCountDown(true)` is the only genuinely
 * live element either platform gives for zero wakeups — everything else would
 * need the widget woken once a minute just to redraw a clock. Its base is on the
 * elapsed-realtime clock, so the wall-clock target has to be converted.
 *
 * The location rides in the format string rather than in a second view: a live
 * view beside a static one has to re-measure the row every second, and the two
 * would disagree about their baseline for one frame each time.
 */
internal fun RemoteViews.countdown(ids: WidgetIds, leaveAt: Long, aside: String?) {
  val now = System.currentTimeMillis()
  setViewVisibility(ids.timer, View.VISIBLE)
  setChronometer(
    ids.timer,
    SystemClock.elapsedRealtime() + (leaveAt - now),
    // `%` in a location would be read as a format specifier by `String.format`
    // and throw inside the launcher, taking the whole tile with it.
    "leave in %s" + if (aside.isNullOrEmpty()) "" else "  ·  ${aside.replace("%", "%%")}",
    true,
  )
  setChronometerCountDown(ids.timer, true)
}
