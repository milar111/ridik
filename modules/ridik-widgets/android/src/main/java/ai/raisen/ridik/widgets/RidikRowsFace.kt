package ai.raisen.ridik.widgets

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.format.DateFormat
import android.view.View
import android.widget.RemoteViews
import java.net.URLEncoder
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.TextStyle
import java.time.temporal.ChronoUnit
import java.util.Locale

/**
 * The other four faces — Calendar, Habits, Tasks and one checklist.
 *
 * One object rather than four, for the same reason the Swift side is one view:
 * they share the frame, the notice pane, the header, the empty-state machinery
 * and the size rule, and differ only in which graphic they draw inside it. Four
 * copies of that would be four places for the two platforms to drift apart.
 *
 * RemoteViews cannot loop, cannot set a width, a height or a column count at
 * runtime and cannot draw a custom view, so every size is its own generated
 * layout and this picks between them. `Slots` is how many cells the picked one
 * has; nothing checks that it is right, because an id the layout does not carry
 * resolves to 0 and every action against it is dropped in silence.
 */
internal object RidikRowsFace {
  /** Must equal `ROW_CAP` in `src/services/widgets/snapshot.ts`. */
  const val ROW_SLOTS = 6

  /**
   * Which face a placed widget is showing. One per provider.
   *
   * `AGENDA` is the Calendar widget. The name is load-bearing and not a display
   * string: Android identifies a widget by its provider class and the resources
   * named from it, so renaming this orphans every tile already on a home screen.
   * Only the label, the description and the drawing changed.
   */
  enum class Kind(val route: String) {
    AGENDA("ridik:///calendar"),
    TASKS("ridik:///tasks"),
    HABITS("ridik:///habits"),
    LIST("ridik:///notes?pane=lists"),
  }

  /**
   * Null when the layout is missing, which means there is nothing to draw at all.
   *
   * `widthDp` and `heightDp` come from the size the launcher gave *this*
   * particular copy of the widget — the same face is a month plate in one corner
   * of the home screen and a plate over a strip over three rows in another.
   */
  fun build(context: Context, kind: Kind, widthDp: Int, heightDp: Int): RemoteViews? {
    val size = drawnSize(kind, sizeOf(widthDp, heightDp))
    val ids = WidgetIds(context, layoutFor(context, kind, size))
    if (ids.layout == 0) return null

    val views = RemoteViews(context.packageName, ids.layout)
    val snapshot = WidgetSnapshotStore.read(context)?.let { WidgetSnapshot.parse(it) }
    views.setOnClickPendingIntent(android.R.id.background, openApp(context, kind, snapshot))

    when {
      snapshot == null -> views.notice(
        ids,
        "Nothing published yet.",
        "Open Ridik once and today lands here.",
      )
      snapshot.version != WidgetSnapshot.SUPPORTED_VERSION -> views.notice(
        ids,
        "Ridik was updated.",
        "Open it once to refresh this widget.",
      )
      else -> {
        val zone = zoneOf(snapshot)
        val now = ZonedDateTime.now(zone)
        when (kind) {
          Kind.AGENDA -> views.calendar(context, ids, snapshot, size, zone, now, heightDp)
          Kind.HABITS -> views.habits(ids, snapshot, size, zone, now)
          Kind.TASKS -> views.tasks(context, ids, snapshot, size, zone, now, heightDp)
          Kind.LIST -> views.list(ids, snapshot, size, heightDp)
        }
      }
    }
    return views
  }

  /**
   * Which layout a size actually inflates.
   *
   * Tasks and the checklist have no large face — twelve age cells and six rows
   * do not want 300dp of height, and stretching them leaves a band of empty
   * ground. They take the medium drawing, and the slot counts have to follow or
   * the face would set cells the layout does not have.
   */
  private fun drawnSize(kind: Kind, size: WidgetSize): WidgetSize = when {
    size != WidgetSize.LARGE -> size
    kind == Kind.TASKS || kind == Kind.LIST -> WidgetSize.MEDIUM
    else -> WidgetSize.LARGE
  }

  /**
   * The clock variant is not decoration: "3:15 PM" needs half again the lead
   * column of "15:15", and a ragged left edge down five rows reads as a
   * rendering fault. RemoteViews cannot set a width at runtime, so the choice is
   * a different file — made against the device's own setting rather than once at
   * build time. Faces with no clock in them need only one.
   */
  private fun layoutFor(context: Context, kind: Kind, size: WidgetSize): String {
    val ampm = if (DateFormat.is24HourFormat(context)) "" else "_ampm"
    val name = size.name.lowercase(Locale.US)
    return when (kind) {
      Kind.AGENDA -> if (size == WidgetSize.SMALL) "ridik_cal_small" else "ridik_cal_$name$ampm"
      Kind.TASKS -> if (size == WidgetSize.SMALL) "ridik_tasks_small" else "ridik_tasks_$name$ampm"
      Kind.HABITS -> "ridik_habits_$name"
      Kind.LIST -> "ridik_list_$name"
    }
  }

  /* ------------------------------------------------------------- the calendar */

  /**
   * Calendar: the month plate, the day's strip, and what is left of the day.
   *
   * Staleness here is two questions and not one, which is what makes this the
   * only Ridik widget that stays honest a week after the app was last opened.
   * The plate is stale when the *month* turns over; the strip and the rows when
   * the *day* does. Both are asked of the payload's own zone, and **neither
   * answer takes the tile away**: a stale face is the same drawing with the day
   * fully spent and a sentence under it, because a notice pane here would empty
   * the home screen every morning until the app was next opened.
   *
   * Large is the only tile in the family with two candidates for its single hot
   * cell, and §3.2 gives it to the *element*: the next thing is actionable and
   * today's date is not. Today on the plate keeps its ring and its own load
   * level — which is also the only way that ring is visible in light mode, where
   * the ring and the hot fill are the same `#C7360F`.
   */
  private fun RemoteViews.calendar(
    context: Context,
    ids: WidgetIds,
    snapshot: WidgetSnapshot,
    size: WidgetSize,
    zone: ZoneId,
    now: ZonedDateTime,
    heightDp: Int,
  ) {
    showBody(ids)
    val monthFresh = describesThisMonth(snapshot, zone)
    val dayFresh = describesToday(snapshot, zone)

    if (size == WidgetSize.SMALL) {
      // The plate alone, and it survives until the month itself turns over. The
      // grid is drawn either way; only the sentence under it changes, and today
      // is simply not on a plate that is no longer this month.
      head(ids, monthName(snapshot, zone), null)
      plate(ids, snapshot.month, zone, numerals = false, allowHot = true)
      when {
        !monthFresh -> say(ids, "Last month's plate.", "Open Ridik to bring this one in.")
        !snapshot.configured.calendar ->
          say(ids, "No events yet.", "Say \"lunch with Ana at one\".")
        snapshot.month.load.none { it != '0' } ->
          say(ids, "${monthName(snapshot, zone).titleCase()} is clear.", null)
        else -> say(ids, null, null)
      }
      return
    }

    // The month is the eyebrow and the day is the number beside it — the same
    // header iOS draws. No count: `agenda` is capped at six by the publisher, so
    // "6 LEFT" would be stated as fact on a day with nine things left on it.
    head(ids, monthName(snapshot, zone), if (dayFresh) dayLabel(now.toLocalDate()) else null)
    // All-day events are a header line, not a list: "flying to Berlin" is
    // exactly what a glance wants, and a calendar that silently drops them is a
    // bug rather than a design gap.
    val allDay = if (dayFresh) snapshot.allDay.firstOrNull() else null
    line(ids.allDay, allDay)

    if (size == WidgetSize.LARGE) {
      setViewVisibility(ids.plateArea, View.VISIBLE)
      // Hot is spent by the element below; today keeps the ring and its own
      // level. The plate itself knows whether it is still this month.
      plate(ids, snapshot.month, zone, numerals = true, allowHot = false)
    }

    val slots = Slots.day(size)
    // A day that has ended is read from past its own last cell, so the strip
    // burns all the way down rather than disappearing.
    val nowMinutes = if (dayFresh) minutesOf(now) else endOfDay(snapshot.day, slots)
    element(context, ids, snapshot.day, slots, nowMinutes)

    if (!dayFresh) {
      setViewVisibility(ids.rowArea, View.GONE)
      // One copy slot and, on large, two things that can be out of date at once
      // — the month cannot have turned without the day turning with it. It names
      // the older of the two, so a plate a month behind says so rather than
      // being described as yesterday.
      if (monthFresh || size != WidgetSize.LARGE) {
        say(ids, "Yesterday's plan.", "Open Ridik to bring today's in.")
      } else {
        say(ids, "Last month's plate.", "Open Ridik to bring this one in.")
      }
      return
    }

    val times = timeFormat(context, zone)
    val rows = snapshot.agenda.map { item ->
      FaceRow(
        lead = times.clock(item.startsAt),
        text = item.title,
        trail = item.location ?: "class".takeIf { item.kind == "class" },
        spoken = listOfNotNull(
          item.title,
          "at ${times.clock(item.startsAt)}",
          item.location,
        ).joinToString(", "),
      )
    }

    if (rows.isEmpty()) {
      setViewVisibility(ids.rowArea, View.GONE)
      if (!snapshot.configured.calendar) {
        say(ids, "No events yet.", "Say \"lunch with Ana at one\".")
      } else {
        // Dropped rather than printed when it rounds to nothing — "0m
        // unclaimed" under "Nothing booked today" is the widget arguing with
        // itself, and there is no copy for that state because it is not one the
        // design has.
        val free = unclaimedMinutes(snapshot.day, nowMinutes).takeIf { it > 0 }
        say(ids, "Nothing booked today.", free?.let { "${spanText(it)} unclaimed." })
      }
      return
    }

    say(ids, null, null)
    setViewVisibility(ids.rowArea, View.VISIBLE)
    // Three rows at most: the strip above is the answer to "how is my day", and
    // the rows are only there to name what the strip has already shown. An
    // all-day line costs one of them at both sizes — it is about 18dp, and a row
    // cut through the middle reads as a rendering fault rather than as a full
    // tile.
    val allDayCost = if (allDay == null) 0 else ALL_DAY_LINE
    val room = if (size == WidgetSize.LARGE) {
      (heightDp - CAL_LARGE_ABOVE - allDayCost) / 2
    } else {
      heightDp - CAL_ABOVE - allDayCost
    }
    val cap = if (allDay == null) CAL_ROWS_MAX else CAL_ROWS_MAX - 1
    rowList(ids, rows.take(capacity(room, cap)), Slots.rows(size))
  }

  /* --------------------------------------------------------------- the habits */

  /**
   * Six rails, and always six whether or not there are six habits.
   *
   * A board occupies its rectangle at zero habits and a list does not: the empty
   * slots teach the capacity without a word. The window is the *last* 7, 21 or
   * 35 days of a 35-day string, so every rail ends on today and the columns line
   * up with each other — which is the read the whole face exists for.
   */
  private fun RemoteViews.habits(
    ids: WidgetIds,
    snapshot: WidgetSnapshot,
    size: WidgetSize,
    zone: ZoneId,
    now: ZonedDateTime,
  ) {
    showBody(ids)
    // A rail's last column is the day the payload describes, so the board goes
    // stale at midnight exactly like the strip does. It is still drawn: the
    // board is six weeks of a habit's life and only its last column is wrong,
    // and a notice pane in its place is the failure this whole family avoids.
    val fresh = describesToday(snapshot, zone)

    head(
      ids,
      "HABITS",
      // A fraction of a day that has ended is a claim about the wrong day.
      if (fresh && snapshot.habitsTotal > 0) "${snapshot.habitsDone}/${snapshot.habitsTotal}"
      else null,
    )
    rails(
      ids,
      snapshot.habitRows,
      Slots.railDays(size),
      showBest = size == WidgetSize.LARGE,
      showRuler = size != WidgetSize.LARGE,
      // The window ends on the day the payload describes, so the letters over
      // the columns name the days the bars actually stand for.
      today = describedDate(snapshot, zone),
      // The last column is not today on a stale board, and lighting it would
      // claim a habit had been logged on a day that has not started.
      marksToday = fresh,
    )

    if (!fresh) {
      say(ids, "Yesterday's plan.", "Open Ridik to bring today's in.")
      return
    }

    val best = snapshot.habitRows.maxOfOrNull { it.longestStreak } ?: 0
    when {
      !snapshot.configured.habits || snapshot.habitsTotal == 0 ->
        say(ids, "Six slots, all cold.", "Say \"I ran today\" and the first one lights.")
      snapshot.habitsDone >= snapshot.habitsTotal ->
        say(
          ids,
          "All ${word(snapshot.habitsTotal)}, today.",
          "Longest run: $best ${if (best == 1) "day" else "days"}.",
        )
      else -> say(ids, null, null)
    }
  }

  /* ---------------------------------------------------------------- the tasks */

  /**
   * Tasks: one cell per open task, oldest left, and the rows under it.
   *
   * The axis is age and not clock time, and the row lead is "9d" rather than the
   * word "late" — the payload has carried the real due date all along, and how
   * far behind you are is the thing the reader actually wants.
   */
  private fun RemoteViews.tasks(
    context: Context,
    ids: WidgetIds,
    snapshot: WidgetSnapshot,
    size: WidgetSize,
    zone: ZoneId,
    now: ZonedDateTime,
    heightDp: Int,
  ) {
    showBody(ids)
    // Every number on this face is a tally of a particular day, so a payload
    // from a day that has ended keeps its shape and loses its counts: a cold
    // strip, no footer, no header number, and the sentence underneath.
    val fresh = describesToday(snapshot, zone)

    head(
      ids,
      "TASKS",
      when {
        !fresh -> null
        // Overdue outranks due: it is the number that should pull the eye, and
        // showing both would spend the whole header line on arithmetic.
        snapshot.overdue > 0 -> "${snapshot.overdue} LATE"
        snapshot.dueToday > 0 -> "${snapshot.dueToday} DUE"
        else -> null
      },
    )

    debt(ids, if (fresh) snapshot.taskAges else emptyList(), Slots.debt(size))
    val open = snapshot.overdue + snapshot.dueToday
    val oldest = snapshot.taskAges.firstOrNull() ?: 0
    // The cells are capped at 12 or 24; the footer is where the true count goes,
    // or a tile with thirty overdue tasks would quietly claim twenty-four.
    line(ids.footLeft, if (fresh && oldest > 0) "oldest ${oldest}d" else null)
    line(ids.footRight, if (fresh && open > 0) "$open open" else null)

    if (!fresh) {
      setViewVisibility(ids.rowArea, View.GONE)
      say(ids, "Yesterday's plan.", "Open Ridik to bring today's in.")
      return
    }

    val times = timeFormat(context, zone)
    val today = now.toLocalDate()
    val rows = snapshot.taskRows.map { task ->
      FaceRow(
        lead = if (task.overdue) daysLate(task.dueAt, zone, today) else times.clock(task.dueAt),
        text = task.title,
        trail = null,
        spoken = listOfNotNull(
          task.title,
          if (task.overdue) "overdue" else "due ${times.clock(task.dueAt)}",
        ).joinToString(", "),
      )
    }

    when {
      !snapshot.configured.tasks ->
        say(ids, "No tasks yet.", "Say \"remind me to call the landlord Friday\".")
      snapshot.taskAges.isEmpty() -> say(ids, "Clear.", "Nothing due, nothing late.")
      else -> say(ids, null, null)
    }

    // Small has no row slots at all: a 46dp lead on a two-cell tile leaves the
    // title nothing, so the age cells take the height instead.
    if (size == WidgetSize.SMALL) return
    if (rows.isEmpty()) {
      setViewVisibility(ids.rowArea, View.GONE)
      return
    }
    setViewVisibility(ids.rowArea, View.VISIBLE)
    rowList(ids, rows.take(capacity(heightDp - TASKS_ABOVE, ROW_SLOTS)), Slots.rows(size))
  }

  /* ----------------------------------------------------------------- the list */

  /**
   * The quiet one. No cells by decision, beyond the marks themselves.
   *
   * A checklist has no time axis and inventing one would be decoration — and one
   * tile without a graphic is what makes the other four read as chosen rather
   * than as a house style applied everywhere.
   *
   * Deliberately not gated on the day: a shopping list does not expire at
   * midnight, and "Yesterday's plan" over a list of bolts would be nonsense.
   */
  private fun RemoteViews.list(
    ids: WidgetIds,
    snapshot: WidgetSnapshot,
    size: WidgetSize,
    heightDp: Int,
  ) {
    showBody(ids)
    val list = snapshot.list

    if (list == null) {
      head(ids, "LISTS", null)
      // The marks are this face's only graphic, so they stay: a column of cold
      // ticks is what an empty checklist looks like, and hiding them would make
      // this the one empty state in the family that is a bare sentence on a flat
      // rectangle.
      setViewVisibility(ids.rowArea, View.VISIBLE)
      coldTicks(ids, capacity(heightDp - LIST_ABOVE, EMPTY_TICKS))
      say(ids, "No list yet.", "Say \"add bolts to the hardware list\".")
      return
    }

    head(ids, list.name.uppercase(Locale.getDefault()), openCount(list))
    setViewVisibility(ids.rowArea, View.VISIBLE)
    tickList(ids, list.rows.take(capacity(heightDp - LIST_ABOVE, ROW_SLOTS)), Slots.rows(size))

    if (list.open == 0 && list.total > 0) {
      // The header already carries the name, so the headline would only repeat
      // it; the sentence is what the state is actually worth saying. `total` is
      // counted before the cap, so a fully ticked list of twelve says twelve and
      // not "All six done."
      say(ids, null, "All ${word(list.total)} done.")
    } else {
      say(ids, null, null)
    }
  }

  /**
   * "4 OF 12" — both numbers counted before the rows were capped.
   *
   * `open` and `total` are tallied over the whole list by the publisher, so this
   * is exact however long the list is. It used to have only the rows it was
   * handed, which are capped at six, and had to degrade to "4 OPEN" rather than
   * claim a list of twelve had six things on it.
   */
  private fun openCount(list: Checklist): String? =
    if (list.total <= 0) null else "${list.open} OF ${list.total}"

  /* --------------------------------------------------------------- the plumbing */

  /** Room above the rows, in dp, for each face that has any. Crude on purpose. */
  private const val CAL_ABOVE = 92
  private const val CAL_LARGE_ABOVE = 96
  private const val TASKS_ABOVE = 96
  private const val LIST_ABOVE = 52
  private const val CAL_ROWS_MAX = 3

  /**
   * What the all-day line costs the rows under it, in dp.
   *
   * A line and three rows do not both fit, on either size, and the row that does
   * not fit is not dropped — it is clipped through the middle, which reads as a
   * rendering fault rather than as a full tile. So the arithmetic has to know.
   */
  private const val ALL_DAY_LINE = 18

  /** Cold marks under "No list yet." — the same four iOS draws. */
  private const val EMPTY_TICKS = 4

  /**
   * How many rows fit in the space left over, from the size the launcher reports.
   *
   * The arithmetic is deliberately crude: a row is about 22dp with its gap, and
   * this only has to be right to the nearest one. Erring short leaves air rather
   * than half a line of text, which is the failure worth having — the rows sit
   * in a weighted container and anything past the bottom is clipped, not pushed.
   */
  private fun capacity(roomDp: Int, cap: Int): Int {
    if (roomDp <= 0) return minOf(3, cap)
    return (roomDp / 22).coerceIn(1, cap)
  }

  /** "AUGUST" — the plate's own header, from the payload's month and not the device's. */
  private fun monthName(snapshot: WidgetSnapshot, zone: ZoneId): String {
    val month = runCatching { YearMonth.parse(snapshot.month.month) }
      .getOrElse { YearMonth.now(zone) }
    return month.month.getDisplayName(TextStyle.FULL, Locale.getDefault())
      .uppercase(Locale.getDefault())
  }

  /** "AUGUST" is the eyebrow; "August is clear." is a sentence. */
  private fun String.titleCase(): String =
    lowercase(Locale.getDefault()).replaceFirstChar { it.uppercase(Locale.getDefault()) }

  /**
   * "9d", "2d" — how far behind, which is the thing the reader wants.
   *
   * Measured in whole local days between the due date and today, both in the
   * payload's zone: subtracting epoch milliseconds would call anything overdue
   * by 23 hours "0d" and anything overdue by 25 "1d", depending on the hour the
   * model happened to invent.
   */
  private fun daysLate(dueAt: Long?, zone: ZoneId, today: LocalDate): String {
    if (dueAt == null) return "late"
    val due = Instant.ofEpochMilli(dueAt).atZone(zone).toLocalDate()
    val days = ChronoUnit.DAYS.between(due, today).toInt()
    return if (days < 1) "late" else "${days}d"
  }

  /**
   * Where a tap lands.
   *
   * The list widget opens the list it was showing rather than the pane in
   * general — `?pane=lists&list=Hardware` is the only address a checklist has.
   * The request code is the kind's own, or `FLAG_UPDATE_CURRENT` would hand
   * every widget on the home screen whichever intent was built last.
   */
  private fun openApp(context: Context, kind: Kind, snapshot: WidgetSnapshot?): PendingIntent {
    val name = snapshot?.list?.name
    val target = if (kind == Kind.LIST && !name.isNullOrBlank()) {
      "${kind.route}&list=${URLEncoder.encode(name, "UTF-8")}"
    } else {
      kind.route
    }
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(target)).setPackage(context.packageName)
    return PendingIntent.getActivity(
      context,
      kind.ordinal + 1,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }
}
