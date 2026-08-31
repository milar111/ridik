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
    // Opens Today: the face answers "what am I supposed to be doing", and Today
    // is the screen that answers it at length.
    NOWNEXT("ridik:///today"),
    RINGS("ridik:///habits"),
    PEOPLE("ridik:///people"),
    // Opens the calendar: the face is a week, and the month plate is where a
    // week is read at length.
    CHAIN("ridik:///calendar"),
    COUNTDOWN("ridik:///today"),
    // The four rastered faces. All but Term are alternative readings of today,
    // so they open the day; Term is a calendar year and opens the calendar.
    HORIZON("ridik:///today"),
    SUNDIAL("ridik:///today"),
    ROUTE("ridik:///today"),
    TERM("ridik:///calendar"),
    // Opens Today, where a session is started and stopped.
    FOCUS("ridik:///today"),
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
          Kind.NOWNEXT -> views.nowNext(context, ids, snapshot, size, zone, now)
          Kind.RINGS -> views.rings(ids, snapshot, size)
          Kind.PEOPLE -> views.people(ids, snapshot, size, heightDp)
          Kind.CHAIN -> views.chain(ids, snapshot, size)
          Kind.COUNTDOWN -> views.countdownFace(context, ids, snapshot, zone, now)
          Kind.HORIZON -> views.plotted(context, kind, ids, snapshot, size, zone, now, widthDp)
          Kind.SUNDIAL -> views.plotted(context, kind, ids, snapshot, size, zone, now, widthDp)
          Kind.ROUTE -> views.plotted(context, kind, ids, snapshot, size, zone, now, widthDp)
          Kind.TERM -> views.plotted(context, kind, ids, snapshot, size, zone, now, widthDp)
          Kind.FOCUS -> views.focus(context, ids, snapshot, size)
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
    // Habits is sized on width alone, and capped at medium: six rows cannot grow
    // to meet 300dp of height, so a large board was three weeks of rails over a
    // third of a tile of ground. The five-week variant is no longer generated.
    if (kind == Kind.HABITS) return minOf(railSizeOf(widthDp), WidgetSize.MEDIUM)
    val size = sizeOf(widthDp, heightDp)
    // Now / Next has no small layout at all — three columns in 131dp truncates
    // every title — so a squeezed tile is floored to medium rather than left
    // asking for a file that does not exist. An unresolved layout draws nothing.
    if (kind == Kind.NOWNEXT && size == WidgetSize.SMALL) return WidgetSize.MEDIUM
    // Rings has no small layout either: two rings is not a set. Floored rather
    // than left asking for a file that does not exist.
    // Four faces have a medium layout and nothing else, so every tile of them
    // is drawn at medium whatever the launcher reports. Floored rather than
    // left asking for a file that was never generated: an unresolved layout id
    // draws *nothing at all*, which is a blank tile with nothing failing
    // anywhere. `sizes` in the Android plugin is the other end of this list.
    if (kind == Kind.RINGS || kind == Kind.ROUTE ||
      kind == Kind.HORIZON || kind == Kind.SUNDIAL
    ) {
      return WidgetSize.MEDIUM
    }
    return when {
      size != WidgetSize.LARGE -> size
      // Tasks still has no large face and is folded back to medium. `LIST` used
      // to be here with it and no longer is: the checklist earned a large layout
      // (eleven rows), and leaving it in this clause is what would have made
      // that layout dead code — generated, shipped, and never asked for.
      // Chain joins them: seven cells and their dates is a line, and a line is
      // not made more informative by being 300dp tall.
      // Every face that is a single graphic and a line under it. Extra height
      // buys more cells before it buys air (§2 rule 1), and none of these has
      // another cell to draw: the day has 32 and the year has 365 whatever the
      // tile is.
      kind == Kind.TASKS || kind == Kind.PEOPLE || kind == Kind.CHAIN ||
        kind == Kind.COUNTDOWN || kind == Kind.HORIZON || kind == Kind.SUNDIAL ||
        kind == Kind.ROUTE || kind == Kind.TERM || kind == Kind.FOCUS -> WidgetSize.MEDIUM
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
      // No small variant exists, and `sizeOf` can still report SMALL for a
      // tile the user squeezed. Medium is the floor rather than a missing
      // file: an unresolved layout draws nothing at all.
      Kind.NOWNEXT -> if (size == WidgetSize.LARGE) "ridik_nownext_large" else "ridik_nownext_medium"
      Kind.RINGS -> "ridik_rings_medium"
      Kind.PEOPLE -> "ridik_people_$name$ampm"
      Kind.CHAIN -> "ridik_chain_$name"
      Kind.COUNTDOWN -> "ridik_countdown_$name"
      // Route has no small layout at all — 32 segments in 131dp is four dp
      // each, below the width at which a break between two of them can be seen.
      // Floored to medium rather than left asking for a file that does not
      // exist, because an unresolved layout draws nothing.
      Kind.ROUTE -> "ridik_route_medium"
      Kind.HORIZON -> "ridik_horizon_medium"
      Kind.SUNDIAL -> "ridik_sundial_medium"
      Kind.TERM -> "ridik_term_$name"
      Kind.FOCUS -> "ridik_focus_$name"
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

  /**
   * People — Tasks' age strip, pointed at promises.
   *
   * Deliberately **not** gated on the day, which is the one way it differs from
   * the face it borrows from. Tasks is a tally of a particular day and loses its
   * counts when the payload is yesterday's; a promise made three weeks ago is
   * exactly as owed this morning as it was last night. "Yesterday's plan" over a
   * list of promises would be a claim about the wrong thing.
   *
   * The ages are days since the promise was *made*, not days past due — most of
   * these rows have no due date at all, which is precisely why nothing else in
   * the app ever shows them.
   */
  private fun RemoteViews.people(
    ids: WidgetIds,
    snapshot: WidgetSnapshot,
    size: WidgetSize,
    heightDp: Int,
  ) {
    showBody(ids)

    head(ids, "PEOPLE", if (snapshot.peopleOwed > 0) "${snapshot.peopleOwed} OWED" else null)

    debt(ids, snapshot.peopleAges, Slots.debt(size))
    val oldest = snapshot.peopleAges.firstOrNull() ?: 0
    // The strip is capped at 12 or 24; the footer carries the true counts, or a
    // tile owing thirty things would quietly claim twenty-four.
    line(ids.footLeft, if (oldest > 0) "oldest ${oldest}d" else null)
    line(
      ids.footRight,
      if (snapshot.peopleCount > 0) {
        "${snapshot.peopleCount} ${if (snapshot.peopleCount == 1) "person" else "people"}"
      } else {
        null
      },
    )

    val rows = snapshot.peopleRows.map { promise ->
      FaceRow(
        // Age in the lead column, where Tasks puts a time: it is the number the
        // strip is drawn from, so the row and the cell above it agree.
        lead = "${promise.age}d",
        text = promise.text,
        trail = promise.name,
        spoken = "${promise.text}, to ${promise.name}, ${promise.age} days ago",
      )
    }

    if (snapshot.peopleOwed == 0) {
      say(ids, "Nothing owed.", "Say \"I promised Ana the reading list\".")
      setViewVisibility(ids.rowArea, View.GONE)
      return
    }

    say(ids, null, null)
    if (rows.isEmpty()) {
      setViewVisibility(ids.rowArea, View.GONE)
      return
    }
    setViewVisibility(ids.rowArea, View.VISIBLE)
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
  /**
   * Now / Next / Later — three slots, and the only face that answers a question.
   *
   * Everything here is classified from the payload against *this process's* clock
   * rather than from anything the publisher decided. That is deliberate: the
   * agenda is "what is left of today", and which of those rows is happening
   * right now changes every minute while nothing is republished. A face that
   * asked the payload which slot was which would be wrong for up to half an hour
   * at a time and look completely plausible doing it.
   *
   * `NOW` is the row the clock is inside; when nothing is running the slot says
   * so rather than borrowing the next thing, because "now: Robotics lab" when
   * Robotics lab starts in two hours is the one lie this face could tell.
   */
  /**
   * The completion rings — a share per habit, and the one proportion the family
   * draws. See §1 for the narrowing that permits it and `RidikRings.kt` for why
   * the arc is a white bitmap rather than a coloured one.
   *
   * Habit order is the payload's order and never sorted here: a rail is read
   * down its columns, and re-sorting by how well each is going would reshuffle
   * the board every time anything is logged. The rings inherit that rule so a
   * ring and a rail describe the same habit in the same position.
   */
  private fun RemoteViews.rings(
    ids: WidgetIds,
    snapshot: WidgetSnapshot,
    size: WidgetSize,
  ) {
    showBody(ids)
    val slots = ringSlots(size)
    val rows = snapshot.habitRows

    head(ids, "HABITS", if (rows.isEmpty()) null else "${snapshot.habitsDone}/${snapshot.habitsTotal}")

    for (index in 0 until slots) {
      val ring = ids.id("ridik_ring_$index")
      val value = ids.id("ridik_ring_value_$index")
      val name = ids.id("ridik_ring_name_$index")
      val row = rows.getOrNull(index)
      if (row == null) {
        // Hidden rather than drawn empty: an unused column with a 0% ring in it
        // is a habit the user does not have, reported as one they are failing.
        setViewVisibility(ring, View.GONE)
        setViewVisibility(value, View.GONE)
        setViewVisibility(name, View.GONE)
        continue
      }
      setViewVisibility(ring, View.VISIBLE)
      setViewVisibility(value, View.VISIBLE)
      setViewVisibility(name, View.VISIBLE)
      setImageViewBitmap(ring, RidikRings.ring(RING_PX, RidikRings.rate(row.history)))
      setTextViewText(value, RidikRings.label(row.history))
      setTextViewText(name, row.name)
      setContentDescription(
        ring,
        "${row.name}, ${RidikRings.label(row.history)} of the last ${row.history.length} days",
      )
    }

    if (rows.isEmpty()) {
      say(ids, "No habits yet.", "Say \"add gym to my habits\".")
    } else {
      say(ids, null, null)
    }
  }

  /**
   * The bitmap's pixel size.
   *
   * Fixed rather than derived from the tile: the `ImageView` is `RING_DP` (42dp)
   * and scales what it is given with `fitCenter`, so one generous raster is sharp
   * at every density instead of the provider having to know the launcher's. 168
   * is exactly 4x of 42, so the densest launcher still gets a whole pixel.
   */
  private const val RING_PX = 168

  /** Must equal `RING_SLOTS_BY_SIZE` in the Android plugin. */
  private fun ringSlots(size: WidgetSize) = when (size) {
    WidgetSize.SMALL -> 2
    else -> 6
  }

  /* ------------------------------------------------------------------ focus */

  /**
   * Focus — the one face with a live clock over something that has a natural end.
   *
   * §3.1's countdown is honest and narrow: it counts to a travel buffer, which
   * most things on a calendar do not have. A *running session* is the one thing
   * in the app that deserves the `Chronometer` more, because it ends in forty
   * minutes by construction rather than by inference.
   *
   * ## Nothing running is a state, and it is the common one
   *
   * A timer tile showing a stale `00:00` is worse than a blank one, so the empty
   * state hides the clock entirely, draws the strip fully cold and says so in
   * words. That is §4 applied to a face whose whole content is a number.
   *
   * ## Paused stops the clock rather than freezing a number in it
   *
   * The payload sends `0` for both moments while paused, because a paused
   * session has no end — the minutes left are known, when they finish is not.
   * A `Chronometer` pointed at a receding moment is wrong every second it is on
   * screen, so it is hidden and the eyebrow says PAUSED instead. The strip keeps
   * its marker where the pause caught it.
   */
  private fun RemoteViews.focus(
    context: Context,
    ids: WidgetIds,
    snapshot: WidgetSnapshot,
    size: WidgetSize,
  ) {
    showBody(ids)
    val focus = snapshot.focus
    val slots = WidgetSnapshot.FOCUS_CELLS

    if (focus == null) {
      head(ids, "FOCUS", null)
      setViewVisibility(ids.timer, View.GONE)
      line(ids.timerNote, null)
      line(ids.nextTitle, null)
      // Cold, and every cell stated: a widget is *reapplied* onto the views it
      // drew last time, so a strip left alone keeps the last session's shape.
      for (slot in 0 until slots) coldCell(ids, slot)
      say(ids, "No session.", "Say \"focus for 40 minutes\".")
      return
    }

    head(
      ids,
      if (focus.onBreak) "BREAK" else "FOCUS",
      if (focus.paused) "PAUSED" else null,
    )
    line(ids.nextTitle, focus.label)
    say(ids, null, null)

    val remaining = focus.phaseEndsAt - System.currentTimeMillis()
    if (!focus.paused && focus.phaseEndsAt > 0L && remaining > 0L) {
      countdown(ids, focus.phaseEndsAt, aside = null, verb = "")
      setContentDescription(
        ids.timer,
        "${focus.label}, ${remaining / 60_000} minutes left in this ${focus.phase}",
      )
      line(ids.timerNote, if (focus.onBreak) "ON THIS BREAK" else "OF FOCUS LEFT")
      // The instant the phase runs out, so the tile does not sit counting past
      // its own base for up to half an hour.
      LeaveAlarm.at(context, focus.phaseEndsAt, RidikFocusWidgetProvider::class.java, FOCUS_ALARM)
    } else {
      setViewVisibility(ids.timer, View.GONE)
      line(ids.timerNote, null)
    }

    for (slot in 0 until slots) {
      val level = focus.load[slot] - '0'
      val spent = slot < focus.nowCell
      val hot = slot == focus.nowCell
      cell(ids, slot, if (hot) 3 else level, spent, slot > 0 && focus.breaks[slot] == '1', context)
    }
    setContentDescription(
      ids.dayArea,
      "${focus.label}, cell ${focus.nowCell + 1} of $slots",
    )
  }

  /** Focus's own alarm request code — see `COUNTDOWN_ALARM` for why it differs. */
  private const val FOCUS_ALARM = 902

  /**
   * One cell of the session strip: the level, whether it is behind you, and
   * whether a phase begins at it.
   *
   * The same two-view burn-down the day strip uses — a full-height cell and a
   * 38% one, one of which is hidden — because `RemoteViews` cannot set a height
   * before API 31 and this app ships to 26.
   */
  private fun RemoteViews.cell(
    ids: WidgetIds,
    slot: Int,
    level: Int,
    spent: Boolean,
    boundary: Boolean,
    context: Context,
  ) {
    val cell = ids.id("ridik_cell_$slot")
    val full = ids.id("ridik_cell_${slot}_full")
    val burned = ids.id("ridik_cell_${slot}_spent")
    setViewVisibility(cell, View.VISIBLE)
    setViewVisibility(full, if (spent) View.GONE else View.VISIBLE)
    setViewVisibility(burned, if (spent) View.VISIBLE else View.GONE)
    background(if (spent) burned else full, ids.heat(level))
    val gap = (2f * context.resources.displayMetrics.density).toInt().coerceAtLeast(1)
    setViewPadding(cell, if (boundary) gap else 0, 0, 0, 0)
  }

  /** A cell with nothing in it, stated rather than left to the last draw. */
  private fun RemoteViews.coldCell(ids: WidgetIds, slot: Int) {
    val cell = ids.id("ridik_cell_$slot")
    val full = ids.id("ridik_cell_${slot}_full")
    val burned = ids.id("ridik_cell_${slot}_spent")
    setViewVisibility(cell, View.VISIBLE)
    setViewVisibility(full, View.VISIBLE)
    setViewVisibility(burned, View.GONE)
    background(full, ids.heat(0))
    setViewPadding(cell, 0, 0, 0, 0)
  }

  /* ------------------------------------------------- the four rastered faces */

  /**
   * The height each raster is drawn at, in dp. Must equal `PLOT_HEIGHT` in the
   * Android plugin, which is what the `ImageView` in the layout is given.
   *
   * Stated in two places because `RemoteViews` cannot read a measured height
   * back: the provider has to know how tall the bitmap should be *before* it
   * draws one, and a constant both ends state is the only way for them to agree.
   */
  /** `PAD_H` in the Android plugin — the frame's padding on each side. */
  private const val TILE_PAD_H = 16

  private fun plotHeightDp(kind: Kind, size: WidgetSize): Int = when (kind) {
    // Skyline, Sundial and Route are medium-only, so one number each — see
    // `drawnSize`, which floors every tile of them to it. Term keeps two,
    // because the month it draws on small is a different period, not the same
    // period drawn smaller.
    // The iOS heights, scaled by the ratio of the two content widths. Every
    // ornament on these faces is sized from the box it is drawn in — the
    // sundial's disc is 13% of the height, the route's line 34% of it — so a
    // taller box does not draw the same picture larger, it draws a *different*
    // picture. `PLOT_HEIGHT` in the Android plugin is the other end of this.
    Kind.HORIZON -> 128
    Kind.SUNDIAL -> 128
    Kind.ROUTE -> 44
    else -> if (size == WidgetSize.SMALL) 104 else 128
  }

  /**
   * Sundial, Horizon, Route and Term — one `setImageViewBitmap` and one line.
   *
   * Four faces and one draw, because they differ only in which method of
   * `RidikPlots` they call and what the line under it says. Everything else —
   * the header, the staleness rule, the empty copy, the accessible description
   * — is the same job, and four copies of it would be four places for the
   * platforms to drift apart.
   *
   * ## Why these four are rasters at all
   *
   * `RemoteViews` cannot set a view's width or height before API 31 and this
   * app ships to 26; it cannot draw a curve at any level; and 365 views would
   * exceed the binder transaction long before the launcher drew them. So the
   * one primitive the rest of the family is built from is unavailable to
   * exactly these four, and each becomes a single white alpha mask tinted by the
   * layout. `RidikPlots` carries the reasoning; the short version is that a
   * colour computed in this process is computed against the wrong night mode.
   *
   * ## All four are alternatives to Today, and Term is the exception
   *
   * Horizon gives a cell a height *and* a level, which is §8's objection to a
   * second encoding of one variable; Sundial and Route trade the strip's
   * countability for a position you can read across a room. None of them should
   * sit on a home screen beside Today — the picker is where that choice is made,
   * and the blurbs say so. Term is the one that composes with anything, because
   * it counts days rather than measuring them.
   */
  private fun RemoteViews.plotted(
    context: Context,
    kind: Kind,
    ids: WidgetIds,
    snapshot: WidgetSnapshot,
    size: WidgetSize,
    zone: ZoneId,
    now: ZonedDateTime,
    widthDp: Int,
  ) {
    showBody(ids)
    val density = context.resources.displayMetrics.density
    // The tile's own width less `PAD_H` on both sides, so the mask is the same
    // *shape* as the `ImageView` it is stretched into. `fitXY` does not preserve
    // aspect: a mask a different shape from its view distorts everything in it,
    // which is how the Route puck became a blot lying across the line.
    val widthPx = ((widthDp - TILE_PAD_H * 2).coerceAtLeast(80) * density).toInt()
    val heightPx = (plotHeightDp(kind, size) * density).toInt()

    if (kind == Kind.TERM) {
      term(ids, snapshot, size, zone, now, widthPx, heightPx)
      return
    }

    val day = snapshot.day
    val fresh = describesToday(snapshot, zone)
    val nowMinutes = if (fresh) now.hour * 60 + now.minute else endOfDay(day, day.load.length)
    // The last cell that has finished. A day that has ended is entirely behind
    // you, which is what makes a stale tile *look* stale rather than current.
    val spentThrough = if (day.cellMinutes <= 0) -1
    else ((nowMinutes - day.startMinute) / day.cellMinutes) - 1

    head(
      ids,
      if (fresh) dayLabel(now.toLocalDate()) else "EARLIER",
      lateCount(snapshot),
    )

    setImageViewBitmap(
      ids.plot,
      when (kind) {
        Kind.SUNDIAL -> RidikPlots.sundial(widthPx, heightPx, day.load, spentThrough)
        Kind.ROUTE -> RidikPlots.route(widthPx, heightPx, day.load, day.breaks, spentThrough)
        else -> RidikPlots.skyline(widthPx, heightPx, day.load, day.breaks, spentThrough)
      },
    )
    setContentDescription(ids.plot, dayDescription(day, nowMinutes))
    setViewVisibility(ids.plot, View.VISIBLE)

    val times = timeFormat(context, zone)
    val next = snapshot.next?.takeIf { fresh }
    line(
      ids.plotNote,
      when {
        !fresh -> null
        next != null -> "${times.clock(next.startsAt)}  ·  ${next.title}"
        else -> null
      },
    )

    // Staleness is said in words and never by taking the drawing away: a spent
    // day is a legitimate reading, and a blank tile is not.
    when {
      !fresh -> say(ids, "Yesterday's plan.", "Open Ridik to refresh it.")
      next == null -> say(ids, "Nothing else today.", null)
      else -> say(ids, null, null)
    }
  }

  /**
   * Term — one dot per day of the month or the year, with today the hot one.
   *
   * Lifted from *one year*, and the only one of the four that needed no
   * amendment: a dot is the cell at its smallest, burn-down is already the rule
   * for what is past, and today is the one hot object.
   *
   * It reads no load at all, which is what lets it sit beside Sundial without
   * the two arguing about what a cell means — one is a count of days, the other
   * a measure of them.
   *
   * There is no *term*, because the app models none. Small draws the month and
   * medium the year, which are the two periods a calendar actually has; naming
   * a semester the user never entered would be the face inventing its own data.
   */
  private fun RemoteViews.term(
    ids: WidgetIds,
    snapshot: WidgetSnapshot,
    size: WidgetSize,
    zone: ZoneId,
    now: ZonedDateTime,
    widthPx: Int,
    heightPx: Int,
  ) {
    // The payload's own day, not the device's: a tile published in another zone
    // must not count a day the user has not had yet.
    val today = runCatching { LocalDate.parse(snapshot.day.date) }.getOrNull()
      ?: now.toLocalDate()
    val month = size == WidgetSize.SMALL

    val total = if (month) today.lengthOfMonth() else today.lengthOfYear()
    val elapsed = if (month) today.dayOfMonth - 1 else today.dayOfYear - 1
    val left = total - elapsed - 1
    val columns = if (month) 7 else 31

    head(
      ids,
      if (month) today.month.getDisplayName(TextStyle.FULL, Locale.getDefault()).uppercase(Locale.getDefault())
      else today.year.toString(),
      "DAY ${elapsed + 1}",
    )
    setImageViewBitmap(ids.plot, RidikPlots.dots(widthPx, heightPx, total, elapsed, columns))
    setViewVisibility(ids.plot, View.VISIBLE)
    setContentDescription(
      ids.plot,
      "Day ${elapsed + 1} of $total, $left left",
    )
    line(ids.plotNote, if (left == 1) "1 day left" else "$left days left")
    // The last day of a period is a real reading and not an empty state, so
    // nothing is said over the drawing — the note already says "0 days left".
    say(ids, null, null)
  }

  /* -------------------------------------------------------------- countdown */

  /**
   * How long you have got, counted down by the platform.
   *
   * The one face that keeps moving when nothing is publishing. A `Chronometer`
   * with `setChronometerCountDown(true)` is the only genuinely live element
   * either platform gives a widget for zero wakeups — everything else would need
   * the tile woken once a minute to redraw a clock, which is a battery cost the
   * family has never paid.
   *
   * ## It counts to the start, not only to the buffer
   *
   * Today's timer counts to `leaveAt`, and says "leave in". That is honest and
   * it is also silent for the majority of a calendar: most things have no travel
   * buffer, so Today's tile shows them with no live number at all. This face
   * counts to whichever comes first and *changes the verb with it* — "leave in"
   * while there is a buffer to leave for, "starts in" when there is not.
   * Carrying the wrong verb over the right number is the single lie a live
   * countdown is in a position to tell, so the two travel together.
   *
   * ## Started, and past
   *
   * A `Chronometer` counts *past* its base as readily as down to it, so one left
   * running unattended reads "starts in -04:31". Two things stop that: the timer
   * is only ever started while there is time left on it, and a one-shot alarm at
   * the target brings the redraw forward to the instant it runs out. Past the
   * buffer the face falls back to the start; past the start it says the thing is
   * happening, which is a different sentence and not a number.
   */
  private fun RemoteViews.countdownFace(
    context: Context,
    ids: WidgetIds,
    snapshot: WidgetSnapshot,
    zone: ZoneId,
    now: ZonedDateTime,
  ) {
    showBody(ids)
    val millis = now.toInstant().toEpochMilli()
    // Gated on the day, unlike the chain: "starts in" over a payload from
    // yesterday would be counting down to a lecture that is already over.
    val next = snapshot.next?.takeIf { describesToday(snapshot, zone) }
    val times = timeFormat(context, zone)

    head(ids, "NEXT", next?.let { times.clock(it.startsAt) })

    if (next == null) {
      setViewVisibility(ids.timer, View.GONE)
      line(ids.nextTitle, null)
      line(ids.nextSub, null)
      say(ids, "Nothing else today.", "Say \"remind me to call Ivo at 4\".")
      return
    }

    line(ids.nextTitle, next.title)
    line(ids.nextSub, next.location?.takeIf { it.isNotBlank() })
    say(ids, null, null)

    // Whichever comes first and is still ahead. The buffer when there is one to
    // leave for, the start otherwise — and the verb travels with the choice.
    val leaveAt = next.leaveAt?.takeIf { it > millis && next.startsAt > millis }
    val target = leaveAt ?: next.startsAt.takeIf { it > millis }

    if (target == null) {
      // Already begun. Nobody needs to be told how long until a thing they are
      // sitting in, and a countdown at zero is a row of noughts that reads as a
      // fault rather than as an answer.
      setViewVisibility(ids.timer, View.GONE)
      line(ids.timerNote, null)
      line(ids.nextSub, listOfNotNull("happening now", next.location?.takeIf { it.isNotBlank() })
        .joinToString("  ·  "))
      return
    }

    // The verb goes *under* the digits rather than inside the `Chronometer`'s
    // format string. One line of "starts in 34:12" at 34sp is fifteen monospace
    // characters and runs off the tile — and the verb is the label on the
    // reading, not the reading. iOS sets the same word the same way.
    countdown(ids, target, aside = null, verb = "")
    line(ids.timerNote, if (leaveAt != null) "TO LEAVE" else "TO GO")
    setContentDescription(
      ids.timer,
      "${next.title}, ${if (leaveAt != null) "leave at" else "starts at"} " +
        times.clock(target),
    )
    LeaveAlarm.at(context, target, RidikCountdownWidgetProvider::class.java, COUNTDOWN_ALARM)
  }

  /**
   * The countdown face's own alarm request code.
   *
   * Distinct from Today's 900: `PendingIntent` identity ignores the `Intent`'s
   * component, so a shared code would have each provider overwrite the other's
   * alarm and only the last scheduled would ever fire.
   */
  private const val COUNTDOWN_ALARM = 901

  /* ------------------------------------------------------------------ chain */

  /**
   * The week as seven cells, Monday first, with today's cell ringed.
   *
   * Every cell is a `@drawable/ridik_heat_<ember>_<level>` reference the
   * launcher resolves in its own process — the same primitive as the day strip
   * and the habits rails, in its `_today` variant for the one day the reader is
   * standing in. Nothing here computes a colour, which is why this face costs
   * almost nothing to have added and cannot suffer the night-mode bug.
   *
   * ## The week is its own payload field, not a slice of the month plate
   *
   * A week that straddles the 1st is half in a month the plate has no cells for.
   * Slicing seven characters out of it would draw those days `cold` — and cold
   * is how this face says *free*, so the tile would report a clear Monday over
   * a Monday with four things on it. `buildWeek` in `snapshot.ts` publishes the
   * seven days directly for exactly that reason.
   *
   * ## Staleness is not asked, deliberately
   *
   * `todayIndex` is -1 when the payload is not this week's, so no cell is ringed
   * and the face simply stops claiming a today. That is the honest degradation:
   * the *shape* of a week published yesterday is still the shape of this week,
   * unlike an agenda, where every row may already be over.
   */
  private fun RemoteViews.chain(ids: WidgetIds, snapshot: WidgetSnapshot, size: WidgetSize) {
    showBody(ids)
    val week = snapshot.week
    val cells = week.load
    // Null rather than today's date when the payload has no week on it: a date
    // strip invented in this process would be seven numbers that agree with
    // nothing, which is worse than seven blanks.
    val start = runCatching { LocalDate.parse(week.startDate) }.getOrNull()
    val clear = cells.count { it == '0' }

    // "WEEK" on a small tile: 130dp has to carry the eyebrow, the count and the
    // gap, and "THIS WEEK" truncated to "THIS W…". An ellipsis promises that
    // something was left out, and what it left out was the word that mattered.
    // `RidikChainView` makes the same substitution at the same size.
    val eyebrow = if (size == WidgetSize.SMALL) "WEEK" else "THIS WEEK"
    head(ids, eyebrow, if (clear == 0) "FULL" else "$clear CLEAR")

    for (index in 0 until CHAIN_DAYS) {
      val level = cells[index] - '0'
      val today = index == week.todayIndex
      val date = start?.plusDays(index.toLong())
      setImageViewResource(ids.id("ridik_chain_$index"), ids.heat(level, today))
      setTextViewText(ids.id("ridik_chain_date_$index"), date?.dayOfMonth?.toString() ?: "")
      setContentDescription(
        ids.id("ridik_chain_date_$index"),
        spokenDay(date, level, today),
      )
    }

    if (clear == CHAIN_DAYS) {
      say(ids, "A clear week.", "Nothing on any of the seven days.")
    } else {
      say(ids, null, null)
    }
  }

  /** Seven, and the layout says so too — `CHAIN_DAYS` in the Android plugin. */
  private const val CHAIN_DAYS = 7

  /**
   * What a screen reader hears for one day.
   *
   * On the *date* rather than the cell, because the cell carries
   * `importantForAccessibility="no"` like every other graphic in this family:
   * a strip of seven unlabelled images is seven stops that say nothing, and the
   * date beside each one is the element that already has a reason to be read.
   */
  private fun spokenDay(date: LocalDate?, level: Int, today: Boolean): String {
    val name = date?.dayOfWeek?.getDisplayName(TextStyle.FULL, Locale.getDefault()) ?: "Day"
    val load = when (level.coerceIn(0, 3)) {
      0 -> "clear"
      1 -> "light"
      2 -> "busy"
      else -> "full"
    }
    val stamp = date?.let { " the ${it.dayOfMonth}" } ?: ""
    return if (today) "Today, $name$stamp, $load" else "$name$stamp, $load"
  }

  private fun RemoteViews.nowNext(
    context: Context,
    ids: WidgetIds,
    snapshot: WidgetSnapshot,
    size: WidgetSize,
    zone: ZoneId,
    now: ZonedDateTime,
  ) {
    showBody(ids)
    val times = timeFormat(context, zone)
    val millis = now.toInstant().toEpochMilli()
    val fresh = describesToday(snapshot, zone)

    head(
      ids,
      if (fresh) dayLabel(now.toLocalDate()) else "EARLIER",
      lateCount(snapshot),
    )

    // Half-open on the end, matching every other comparison in this family: an
    // event that ended exactly now is over, not running.
    val running = if (!fresh) null else snapshot.agenda.firstOrNull {
      it.startsAt <= millis && it.endsAt > millis
    }
    val ahead = if (!fresh) emptyList() else snapshot.agenda.filter { it.startsAt > millis }

    // Three slots, filled without ever repeating a row: whatever is running
    // takes NOW, and the queue behind it fills NEXT and LATER in order. When
    // nothing is running the queue starts at NEXT and NOW stays empty — the
    // honest answer, and the one the empty copy is written for.
    val slots = listOf(
      running,
      ahead.getOrNull(0),
      ahead.getOrNull(1),
    )

    for (index in 0 until 3) {
      val row = slots[index]
      val time = ids.id("ridik_slot_time_$index")
      val title = ids.id("ridik_slot_title_$index")
      if (row == null) {
        setTextViewText(time, "—")
        // Not blank: a slot with nothing in it is a real answer, and an empty
        // column reads as a face that failed to load.
        setTextViewText(title, if (index == 0) "nothing running" else "nothing")
        setContentDescription(title, if (index == 0) "Nothing running" else "Nothing scheduled")
        continue
      }
      setTextViewText(time, times.clock(row.startsAt))
      setTextViewText(title, row.title)
      setContentDescription(title, "${SLOT_WORDS[index]}, ${row.title}, ${times.clock(row.startsAt)}")
    }

    // The day element, at **both** sizes.
    //
    // §2 rule 1 — extra height buys more cells before it buys air — and three
    // words across the top of a two-row tile with nothing under them was air.
    // The strip is the one thing that can fill it while still saying something,
    // and it is the same generator Today draws, so this face and a Today tile
    // beside it show the identical day.
    //
    // It was in the *layout* for large and never filled by anything, which drew
    // a fully cold strip under a live answer: a widget is reapplied onto the
    // views it drew last time, so an untouched strip is whatever the XML shipped.
    val slotCount = Slots.day(size)
    val nowMinutes = if (fresh) now.hour * 60 + now.minute else endOfDay(snapshot.day, slotCount)
    element(context, ids, snapshot.day, slotCount, nowMinutes)
  }

  /** The words the slots are labelled with, for the spoken description. */
  private val SLOT_WORDS = listOf("Now", "Next", "Later")

  /** `3 LATE`, or nothing when nothing is. The same tally Tasks puts here. */
  private fun lateCount(snapshot: WidgetSnapshot): String? {
    // Flattened on this side: the Kotlin snapshot lifts the task counts onto the
    // root, where Swift keeps them nested under `tasks`.
    val late = snapshot.overdue
    return if (late > 0) "$late LATE" else null
  }

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
      coldTicks(
        ids,
        capacity(
          heightDp - LIST_ABOVE - LIST_NOTE_LINE,
          listRows(size, closing = true),
          Slots.listRows(size),
        ),
      )
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
    // A large tile spends a row on the "+N done" tally the same way it spends
    // one on the closing sentence — the caption sits in the row area either way.
    val hasTally = size == WidgetSize.LARGE && list.total - list.open > DONE_ROWS_ON_LARGE
    val room = heightDp - LIST_ABOVE - if (closing || hasTally) LIST_NOTE_LINE else 0
    val fit = capacity(room, listRows(size, closing || hasTally), Slots.listRows(size))
    val (drawn, hiddenDone) = rationList(list.rows, fit, size)
    tickList(ids, drawn, Slots.listRows(size))

    if (hiddenDone > 0) {
      // Counted rather than silently dropped. `4 OF 12` in the header says what
      // is left; this says what is already behind you and is not on the tile,
      // which is the half a capped list would otherwise misreport.
      say(ids, null, "+$hiddenDone done")
    } else if (closing) {
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
    (when (size) {
      WidgetSize.SMALL -> 4
      WidgetSize.MEDIUM -> 5
      // Eleven, matching iOS: 321dp holds that many at 20dp with the header,
      // and this is the one face people read rather than glance at.
      WidgetSize.LARGE -> 11
    }) - if (closing) 1 else 0

  /**
   * How many struck-through rows a large tile may show before they are counted.
   *
   * Open-first with everything ticked after it works at five rows because you
   * rarely see both halves. At eleven you always do, and a list two-thirds
   * crossed out reads as *finished* when most of it is not — the one misreading
   * a tile that is entirely a tally cannot afford.
   *
   * Capped rather than dropped: the ticked rows are the only evidence on the
   * face that it is showing a list somebody is working through, so hiding them
   * would make a live tile and a three-day-stale one identical.
   *
   * Same number as `doneRowsOnLarge` in `RidikRowsView.swift`, for the same
   * reason the row counts match: the same list must not be a different length on
   * the phone next to yours.
   */
  private const val DONE_ROWS_ON_LARGE = 3

  /**
   * The rows a large checklist actually draws, and how many ticked ones it hid.
   *
   * `snapshot.ts` already sorts open before done, so this splits on `done`
   * rather than re-deriving an order — two orderings would eventually disagree.
   */
  private fun rationList(
    rows: List<ListRow>,
    room: Int,
    size: WidgetSize,
  ): Pair<List<ListRow>, Int> {
    if (size != WidgetSize.LARGE) return rows.take(room) to 0
    val open = rows.filter { !it.done }
    val finished = rows.filter { it.done }
    val openShown = open.take(room)
    val roomLeft = (room - openShown.size).coerceAtLeast(0)
    val doneShown = finished.take(minOf(roomLeft, DONE_ROWS_ON_LARGE))
    return (openShown + doneShown) to (finished.size - doneShown.size)
  }

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
  private fun capacity(roomDp: Int, cap: Int, slots: Int = ROW_SLOTS): Int {
    val ceiling = minOf(cap, slots)
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
