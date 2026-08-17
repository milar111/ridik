package ai.dby.ridik.widgets

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
  /**
   * How many rows the *payload* carries. Must equal `ROW_CAP` in
   * `src/services/widgets/snapshot.ts`.
   *
   * It is a ceiling and not a count: every face draws fewer than this — the
   * Calendar three, Tasks two or three, the checklist four or five — and asking
   * for more than the publisher sends would draw an empty row and call it a
   * quiet day.
   */
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
    val size = drawnSize(kind, widthDp, heightDp)
    // Read before the layout is picked, not after: the ember is part of the
    // layout's name. RemoteViews cannot recolour a `TextView` on a build that
    // ships to API 26 — and a colour resolved in this process would be resolved
    // against this process's night mode, which is the bug that cost a day — so
    // an ember-tinted word is a different file, exactly as a 12-hour clock is.
    val snapshot = WidgetSnapshotStore.read(context)?.let { WidgetSnapshot.parse(it) }
    val ids = idsFor(
      context,
      layoutFor(context, kind, size),
      snapshot?.ember ?: WidgetSnapshot.DEFAULT_EMBER,
    )
    if (ids.layout == 0) return null

    val views = RemoteViews(context.packageName, ids.layout)
    views.setOnClickPendingIntent(android.R.id.background, openApp(context, kind, snapshot))
    // The header's mic, on every face that has room for one. The tile opens the
    // screen it is about; this is the only tap on it that starts a sentence.
    views.speakable(context, ids)

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
  /**
   * Which generated layout this tile gets.
   *
   * Habits is sized on width alone — see `railSizeOf`. Every other face gains
   * *rows* when it gets taller, so height promoting it to large is right there
   * and wrong on a board that only ever gains columns.
   *
   * Tasks and List have no large variant: they are lists, and a list twice as
   * tall is the same list with more of it, which the medium layout already does.
   */
  private fun drawnSize(kind: Kind, widthDp: Int, heightDp: Int): WidgetSize {
    if (kind == Kind.HABITS) return railSizeOf(widthDp)
    val size = sizeOf(widthDp, heightDp)
    return when {
      size != WidgetSize.LARGE -> size
      kind == Kind.TASKS || kind == Kind.LIST -> WidgetSize.MEDIUM
      else -> WidgetSize.LARGE
    }
  }

  /**
   * The clock variant is not decoration: "3:15 PM" needs half again the lead
   * column of "15:15", and a ragged left edge down five rows reads as a
   * rendering fault. RemoteViews cannot set a width at runtime, so the choice is
   * a different file — made against the device's own setting rather than once at
   * build time. Faces with no clock in them need only one.
   *
   * The ember is the same kind of choice for the same kind of reason, and is
   * appended by `idsFor` rather than here: this returns the base name, and
   * every base has one file per ember behind it.
   */
  private fun layoutFor(context: Context, kind: Kind, size: WidgetSize): String {
    val ampm = if (DateFormat.is24HourFormat(context)) "" else "_ampm"
    val name = size.name.lowercase(Locale.US)
    return when (kind) {
      // Calendar small is the plate alone — no rows, so no clock, so no second
      // variant. Tasks small has two rows now and needs one at every size.
      Kind.AGENDA -> if (size == WidgetSize.SMALL) "ridik_cal_small" else "ridik_cal_$name$ampm"
      Kind.TASKS -> "ridik_tasks_$name$ampm"
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
   * every ember draws the ring and the hot fill in the same colour.
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
    // Three rows at most, which is what iOS draws at both sizes: the strip
    // above is the answer to "how is my day", and the rows are only there to
    // name what the strip has already shown. An all-day line costs one of them
    // — it is about 18dp, and a row cut through the middle reads as a rendering
    // fault rather than as a full tile.
    //
    // On large the plate and the rows are the two weighted areas and split
    // what is left between them, so the rows get half of it; the line is a
    // fixed cost taken off the top before the halving, not out of the rows'
    // half alone.
    val allDayCost = if (allDay == null) 0 else ALL_DAY_LINE
    val room = if (size == WidgetSize.LARGE) {
      (heightDp - CAL_LARGE_ABOVE - allDayCost) / 2
    } else {
      heightDp - CAL_ABOVE - allDayCost
    }
    val cap = if (allDay == null) CAL_ROWS else CAL_ROWS - 1
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
          "All ${number(snapshot.habitsTotal)}, today.",
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

    if (rows.isEmpty()) {
      setViewVisibility(ids.rowArea, View.GONE)
      return
    }
    setViewVisibility(ids.rowArea, View.VISIBLE)
    // Two on small and three on medium — iOS's counts. Small drew none at all
    // and medium drew up to six, so one payload made two different tiles: the
    // same phone beside the same iPhone listed six tasks against three. The
    // height clamp stays under them, because an Android tile can be half the
    // height of the family it stands in and a row clipped through the middle
    // is worse than a row not drawn.
    rowList(ids, rows.take(capacity(heightDp - TASKS_ABOVE, taskRows(size))), Slots.rows(size))
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
      // rectangle. As many as a full list would have shown on the same tile —
      // an empty face drawing a shorter column than a populated one is the tile
      // looking broken rather than empty.
      setViewVisibility(ids.rowArea, View.VISIBLE)
      // The copy is one line of headline and one of sub, and it is paid for
      // once — `LIST_NOTE_LINE` is the pair, not one of them. Charging it twice
      // *and* taking `closing = true` on top took two rows off a column that is
      // supposed to be exactly as long as a populated one: an empty face
      // drawing a shorter graphic than a full one is the tile looking broken
      // rather than empty, which is the whole complaint this state answers.
      coldTicks(ids, capacity(heightDp - LIST_ABOVE - LIST_NOTE_LINE, listRows(size, closing = true)))
      say(ids, "No list yet.", "Say \"add bolts to the hardware list\".")
      return
    }

    head(ids, list.name.uppercase(Locale.getDefault()), openCount(list))
    setViewVisibility(ids.rowArea, View.VISIBLE)
    // Four on small and five on medium, less the row the closing sentence
    // stands in — iOS's numbers exactly. It used to be six wherever six fitted,
    // so the same list was five items long on an iPhone and six on the phone
    // next to it.
    val closing = list.open == 0 && list.total > 0
    val room = heightDp - LIST_ABOVE - if (closing) LIST_NOTE_LINE else 0
    tickList(ids, list.rows.take(capacity(room, listRows(size, closing))), Slots.rows(size))

    if (closing) {
      // The header already carries the name, so the headline would only repeat
      // it; the sentence is what the state is actually worth saying. `total` is
      // counted before the cap, so a fully ticked list of twelve says twelve and
      // not "All six done."
      say(ids, null, "All ${number(list.total)} done.")
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
   *
   * Nothing open is not "0 OF 12": §4 gives that state the name and the
   * sentence "All twelve done." and nothing else, and iOS drops the count for
   * the same reason — a zero in the header argues with the line underneath it.
   */
  private fun openCount(list: Checklist): String? =
    if (list.total <= 0 || list.open <= 0) null else "${list.open} OF ${list.total}"

  /* --------------------------------------------------------------- the plumbing */

  /**
   * Room above the rows, in dp, for each face that has any. Crude on purpose,
   * but it has to count *everything* above them or it hands the rows space
   * another line is already standing in.
   *
   * Both the tile's vertical paddings are in these numbers, and so is every
   * line between them: on Calendar the header, the strip and its ruler; on
   * Tasks the header, the debt strip and the footer; on the checklist the
   * header alone. The all-day line is the one that varies, so it is subtracted
   * separately.
   *
   * They went up by roughly a fifth when the family stopped being cramped. Four
   * things above the rows each got bigger and none of them is optional: the
   * tile is padded 14dp rather than 12 top and bottom, the header's count is
   * the face's hero number at 15sp rather than a 10sp label, every cell run
   * sits in a well that is 6dp taller than the cells in it, and the air between
   * the pieces went up with the rest. `plugins/withRidikAndroidWidget.js` is
   * where each of those numbers lives; this is the only place that adds them
   * up, and nothing checks the sum. Get it wrong low and the last row is
   * clipped through the middle, which reads as a rendering fault rather than
   * as a full tile.
   */
  private const val CAL_ABOVE = 123
  private const val CAL_LARGE_ABOVE = 151
  private const val TASKS_ABOVE = 121
  private const val LIST_ABOVE = 60

  /**
   * One line of copy under the checklist's marks, in dp.
   *
   * The checklist is the one face whose sentence sits *below* its graphic
   * rather than in place of it, so it is the one face where the two compete
   * for the same height. "No list yet." spends two of these; "All twelve
   * done." spends one.
   */
  private const val LIST_NOTE_LINE = 22

  /**
   * How many rows each face draws, which is iOS's count and not the tile's.
   *
   * Android reads its size back from the launcher and could fit more; that is
   * exactly the problem. A widget that lists six tasks beside an iPhone listing
   * three is two products, and the one number the reader carries away — "how
   * far behind am I" — differs between them for no reason either platform
   * could explain.
   */
  private const val CAL_ROWS = 3

  private fun taskRows(size: WidgetSize) = if (size == WidgetSize.SMALL) 2 else 3

  /** The closing sentence stands in a row, so it costs one — as it does on iOS. */
  private fun listRows(size: WidgetSize, closing: Boolean): Int =
    (if (size == WidgetSize.SMALL) 4 else 5) - if (closing) 1 else 0

  /**
   * What the all-day line costs the rows under it, in dp.
   *
   * A line and three rows do not both fit, on either size, and the row that does
   * not fit is not dropped — it is clipped through the middle, which reads as a
   * rendering fault rather than as a full tile. So the arithmetic has to know.
   */
  private const val ALL_DAY_LINE = 22

  /**
   * How many rows fit in the space left over, from the size the launcher reports.
   *
   * The arithmetic is deliberately crude: a row is about 25dp with its gap, and
   * this only has to be right to the nearest one. Erring short leaves air rather
   * than half a line of text, which is the failure worth having — the rows sit
   * in a weighted container and anything past the bottom is clipped, not pushed.
   *
   * Twenty-five and not twenty-two because the gap between two rows went from
   * five dp to seven. Air between rows is most of what separates a list you can
   * read at arm's length from a paragraph, and a row is only worth its gap if
   * the arithmetic knows it has one.
   */
  private fun capacity(roomDp: Int, cap: Int): Int {
    val ceiling = minOf(cap, ROW_SLOTS)
    if (roomDp <= 0) return minOf(3, ceiling)
    return (roomDp / 25).coerceIn(1, ceiling)
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
