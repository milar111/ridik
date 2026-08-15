package ai.raisen.ridik.widgets

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.SpannableString
import android.text.Spanned
import android.text.format.DateFormat
import android.text.style.StrikethroughSpan
import android.view.View
import android.widget.RemoteViews
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.net.URLEncoder
import java.util.Date

/**
 * The four list faces — agenda, tasks, habits and one checklist.
 *
 * One object rather than four, for the same reason `RidikRowsView.swift` is one
 * view: they differ only in which rows they pull out of the snapshot. The
 * layout is shared too, so all four are the same list drawn from the same
 * template, and the two platforms stay the same shape as each other.
 *
 * RemoteViews cannot loop, so the layout carries a fixed set of row slots and
 * this hides the ones it does not fill. `ROW_SLOTS` is the payload's own cap —
 * publishing more rows than there are slots would silently drop them.
 */
internal object RidikRowsFace {
  /** Must equal `ROW_CAP` in `src/services/widgets/snapshot.ts`. */
  const val ROW_SLOTS = 6

  /**
   * Which list a placed widget is showing. One per provider.
   *
   * `timed` picks the shared face's lead column. A clock time needs a fixed
   * width or the titles beside it step in and out on every row — and "10:00 AM"
   * needs half again as much room as "10:00", which is why the choice is made
   * against the device's own clock setting rather than once at build time.
   * RemoteViews cannot set a width at runtime, so each width is its own layout;
   * all three come from one template in `plugins/withRidikAndroidWidget.js`.
   */
  enum class Kind(val route: String, val timed: Boolean) {
    AGENDA("ridik:///calendar", true),
    TASKS("ridik:///tasks", true),
    HABITS("ridik:///habits", false),
    LIST("ridik:///notes?pane=lists", false),
  }

  /**
   * `widthDp` is not decoration: the 12-hour lead reserves 66dp, and on a tile
   * two cells wide that is most of the row. Under `NARROW_DP` the times are
   * dropped to the tight column rather than squeezing every title to nothing.
   */
  private fun layoutFor(context: Context, kind: Kind, widthDp: Int): String = when {
    !kind.timed -> "ridik_rows_tight"
    widthDp in 1 until NARROW_DP -> "ridik_rows"
    DateFormat.is24HourFormat(context) -> "ridik_rows"
    else -> "ridik_rows_ampm"
  }

  /** Two launcher cells on a phone. Below this the wide lead costs more than it says. */
  private const val NARROW_DP = 180

  /** One row as the face draws it, whichever section it came from. */
  private data class Row(
    val lead: String,
    val text: String,
    val trail: String?,
    /** Done or ticked off: struck through and dimmed. */
    val spent: Boolean = false,
    /** Overdue: the lead turns red, and red only means something if it is rare. */
    val alert: Boolean = false,
    /** What TalkBack reads instead of "9 40, colon, Materials lab". */
    val spoken: String,
  )

  /**
   * Null when the layout is missing, which means there is nothing to draw at all.
   *
   * `capacity` comes from the size the launcher gave this particular copy of the
   * widget — the same face is 2 rows tall in one corner of the home screen and 6
   * in another, and drawing 6 into the short one clips the last of them in half.
   */
  fun build(context: Context, kind: Kind, widthDp: Int, heightDp: Int): RemoteViews? {
    val ids = RowIds(context, layoutFor(context, kind, widthDp))
    if (ids.layout == 0) return null

    val views = RemoteViews(context.packageName, ids.layout)
    val snapshot = WidgetSnapshotStore.read(context)?.let { WidgetSnapshot.parse(it) }

    views.setOnClickPendingIntent(android.R.id.background, openApp(context, kind, snapshot))

    when {
      snapshot == null -> views.notice(
        ids,
        "Nothing published yet",
        "Open Ridik once and today lands here.",
      )
      snapshot.version != WidgetSnapshot.SUPPORTED_VERSION -> views.notice(
        ids,
        "Ridik was updated",
        "Open it once to refresh this widget.",
      )
      !describesToday(snapshot) -> views.notice(
        ids,
        "Yesterday's plan",
        "Open Ridik to bring today's in.",
      )
      else -> views.rows(context, ids, kind, snapshot, capacityFor(heightDp))
    }
    return views
  }

  /**
   * How many rows fit, from the size the launcher reports in dp.
   *
   * The arithmetic is deliberately crude: the header and the padding take a
   * little over 40dp between them and each row is about 19dp with its gap. It
   * only has to be right to the nearest row, and erring short leaves air rather
   * than half a line of text.
   */
  fun capacityFor(heightDp: Int): Int {
    if (heightDp <= 0) return 3
    return ((heightDp - 42) / 19).coerceIn(1, ROW_SLOTS)
  }

  /**
   * Whether the numbers still describe the day the user is standing in.
   *
   * Every section is tallied for one calendar day, so at midnight they quietly
   * stop being about today without changing a digit. The device's zone is the
   * closest this process can get — the app's own timezone setting lives in a
   * database the widget cannot open.
   */
  private fun describesToday(snapshot: WidgetSnapshot): Boolean {
    if (snapshot.publishedAt <= 0L) return false
    // The payload's own zone, never the device's. They agree at home and differ
    // by hours the moment the user travels — and a day face that is wrong by
    // hours looks entirely plausible, which is what makes it worth carrying.
    val zone = runCatching { ZoneId.of(snapshot.zone) }.getOrElse { ZoneId.systemDefault() }
    val published = Instant.ofEpochMilli(snapshot.publishedAt).atZone(zone).toLocalDate()
    return published == LocalDate.now(zone)
  }

  private fun RemoteViews.rows(
    context: Context,
    ids: RowIds,
    kind: Kind,
    snapshot: WidgetSnapshot,
    capacity: Int,
  ) {
    setViewVisibility(ids.notice, View.GONE)
    setViewVisibility(ids.body, View.VISIBLE)

    val header = header(kind, snapshot)
    setTextViewText(ids.eyebrow, header.first)
    if (header.second == null) {
      setViewVisibility(ids.count, View.GONE)
    } else {
      setViewVisibility(ids.count, View.VISIBLE)
      setTextViewText(ids.count, header.second)
      setTextColor(ids.count, ids.color(if (header.third) ids.dangerName else ids.softName))
    }

    val rows = rows(context, kind, snapshot).take(capacity)
    if (rows.isEmpty()) {
      setViewVisibility(ids.list, View.GONE)
      setViewVisibility(ids.empty, View.VISIBLE)
      setTextViewText(ids.empty, emptyLine(kind))
    } else {
      setViewVisibility(ids.empty, View.GONE)
      setViewVisibility(ids.list, View.VISIBLE)
    }

    for (slot in 0 until ROW_SLOTS) {
      val row = rows.getOrNull(slot)
      if (row == null) {
        setViewVisibility(ids.row[slot], View.GONE)
        continue
      }
      setViewVisibility(ids.row[slot], View.VISIBLE)
      setTextViewText(ids.lead[slot], row.lead)
      setTextColor(ids.lead[slot], ids.color(if (row.alert) ids.dangerName else ids.emberName))
      setTextViewText(ids.text[slot], if (row.spent) struck(row.text) else row.text)
      setTextColor(ids.text[slot], ids.color(if (row.spent) ids.softName else ids.inkName))
      if (row.trail == null) {
        setViewVisibility(ids.trail[slot], View.GONE)
      } else {
        setViewVisibility(ids.trail[slot], View.VISIBLE)
        setTextViewText(ids.trail[slot], row.trail)
      }
      setContentDescription(ids.row[slot], row.spoken)
    }
  }

  /** Eyebrow, the count beside it, and whether that count is the alarming kind. */
  private fun header(kind: Kind, snapshot: WidgetSnapshot): Triple<String, String?, Boolean> =
    when (kind) {
      Kind.AGENDA -> Triple(
        "TODAY",
        snapshot.agenda.size.takeIf { it > 0 }?.let { "$it left" },
        false,
      )
      // Overdue outranks due: it is the number that should pull the eye, and
      // showing both would spend the whole header line on arithmetic.
      Kind.TASKS ->
        if (snapshot.overdue > 0) {
          Triple("TASKS", "${snapshot.overdue} late", true)
        } else {
          Triple("TASKS", snapshot.dueToday.takeIf { it > 0 }?.let { "$it due" }, false)
        }
      Kind.HABITS -> Triple(
        "HABITS",
        if (snapshot.habitsTotal > 0) "${snapshot.habitsDone}/${snapshot.habitsTotal}" else null,
        false,
      )
      Kind.LIST -> {
        val list = snapshot.list
        if (list == null) {
          Triple("LISTS", null, false)
        } else {
          Triple(
            list.name.uppercase(),
            if (list.open > 0) "${list.open} open" else "done",
            false,
          )
        }
      }
    }

  private fun emptyLine(kind: Kind) = when (kind) {
    Kind.AGENDA -> "Nothing left today"
    Kind.TASKS -> "Nothing due today"
    Kind.HABITS -> "No habits tracked yet"
    Kind.LIST -> "No lists yet"
  }

  private fun rows(context: Context, kind: Kind, snapshot: WidgetSnapshot): List<Row> =
    when (kind) {
      Kind.AGENDA -> snapshot.agenda.map { item ->
        Row(
          lead = clock(context, item.startsAt),
          text = item.title,
          trail = item.location ?: "class".takeIf { item.kind == "class" },
          spoken = listOfNotNull(
            item.title,
            "at ${clock(context, item.startsAt)}",
            item.location,
          ).joinToString(", "),
        )
      }
      // An overdue task's own time is yesterday's, and printing it invites the
      // reader to work out how late it is. The word says it in one glance.
      Kind.TASKS -> snapshot.taskRows.map { task ->
        Row(
          // Days late, not the word. The payload has carried the real due date
          // all along and both faces threw it away for the literal "late".
          lead = if (task.overdue) daysLate(task.dueAt) else clock(context, task.dueAt ?: 0L),
          text = task.title,
          trail = null,
          alert = task.overdue,
          spoken = listOfNotNull(
            task.title,
            if (task.overdue) "overdue" else "due ${clock(context, task.dueAt ?: 0L)}",
          ).joinToString(", "),
        )
      }
      Kind.HABITS -> snapshot.habitRows.map { habit ->
        Row(
          lead = if (habit.doneToday) "✓" else "○",
          text = habit.name,
          // A streak of one is just "today" and not yet worth the word.
          trail = if (habit.streak > 1) "${habit.streak}d" else null,
          spent = habit.doneToday,
          spoken = listOfNotNull(
            habit.name,
            if (habit.doneToday) "done" else "not yet",
            if (habit.streak > 1) "${habit.streak} day streak" else null,
          ).joinToString(", "),
        )
      }
      Kind.LIST -> (snapshot.list?.rows ?: emptyList()).map { item ->
        Row(
          lead = if (item.done) "✓" else "○",
          text = item.text,
          trail = null,
          spent = item.done,
          spoken = "${item.text}, ${if (item.done) "done" else "still open"}",
        )
      }
    }

  /** "9d", "2d" — how far behind, which is the thing the reader wants. */
  private fun daysLate(dueAt: Long?): String {
    if (dueAt == null) return "late"
    val days = ((System.currentTimeMillis() - dueAt) / 86_400_000L).toInt()
    return if (days < 1) "late" else "${days}d"
  }

  private fun struck(text: String): CharSequence {
    val span = SpannableString(text)
    span.setSpan(StrikethroughSpan(), 0, text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    return span
  }

  private fun RemoteViews.notice(ids: RowIds, title: String, body: String) {
    setViewVisibility(ids.body, View.GONE)
    setViewVisibility(ids.notice, View.VISIBLE)
    setTextViewText(ids.noticeTitle, title)
    setTextViewText(ids.noticeBody, body)
  }

  /** Honours the device's 12/24-hour setting, which is why the wire carries epoch ms. */
  private fun clock(context: Context, epochMillis: Long): String =
    DateFormat.getTimeFormat(context).format(Date(epochMillis))

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

  /**
   * The widget's resources are written into the app module by
   * `plugins/withRidikAndroidWidget.js`, and an Android library cannot see the
   * app's `R` — the dependency only points the other way. So they are looked up
   * by name. Nothing can strip them out from under this: the manifest names each
   * provider XML, the provider XML names the layout, and the layout names every
   * id below.
   */
  private class RowIds(context: Context, layoutName: String) {
    private val resources = context.resources
    private val pkg = context.packageName

    val inkName = "ridik_widget_ink"
    val softName = "ridik_widget_ink_soft"
    val emberName = "ridik_widget_ember"
    val dangerName = "ridik_widget_danger"

    val layout = resources.getIdentifier(layoutName, "layout", pkg)
    val body = id("ridik_rows_body")
    val eyebrow = id("ridik_rows_eyebrow")
    val count = id("ridik_rows_count")
    val empty = id("ridik_rows_empty")
    val list = id("ridik_rows_list")
    val notice = id("ridik_rows_notice")
    val noticeTitle = id("ridik_rows_notice_title")
    val noticeBody = id("ridik_rows_notice_body")

    val row = IntArray(ROW_SLOTS) { id("ridik_rows_row_$it") }
    val lead = IntArray(ROW_SLOTS) { id("ridik_rows_lead_$it") }
    val text = IntArray(ROW_SLOTS) { id("ridik_rows_text_$it") }
    val trail = IntArray(ROW_SLOTS) { id("ridik_rows_trail_$it") }

    /**
     * Resolved rather than themed: `setTextColor` takes an int, and the
     * launcher replays these in its own process where a colour *resource* would
     * be looked up against the launcher's resources, not ours.
     */
    fun color(name: String): Int {
      val id = resources.getIdentifier(name, "color", pkg)
      if (id == 0) return 0
      return resources.getColor(id, null)
    }

    private fun id(name: String) = resources.getIdentifier(name, "id", pkg)
  }
}
