package ai.raisen.ridik.widgets

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.format.DateFormat
import android.view.View
import android.widget.RemoteViews
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Date

/**
 * What the widget actually draws.
 *
 * RemoteViews is a list of "set this property on that view id", replayed by the
 * launcher in its own process — so there is no `findViewById`, no custom view
 * and no measuring here. The layout is fixed; the only thing this decides is
 * which of its two panes is visible and what text goes in it.
 *
 * The second pane exists because the first one must never be shown with
 * made-up numbers. A face reading "0 due" when the app has simply never
 * published, or when the counts were tallied for a day that has since ended,
 * is a lie told confidently — so those cases get words instead of digits.
 */
internal object RidikWidgetFace {
  /** Today is the screen this face is a summary of, so it is where a tap lands. */
  private const val TAP_TARGET = "ridik:///today"

  /** Null when the layout is missing, which means there is nothing to draw at all. */
  fun build(context: Context): RemoteViews? {
    val ids = FaceIds(context)
    if (ids.layout == 0) return null

    val views = RemoteViews(context.packageName, ids.layout)
    views.setOnClickPendingIntent(android.R.id.background, openApp(context))

    val snapshot = WidgetSnapshotStore.read(context)?.let { WidgetSnapshot.parse(it) }
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
      else -> views.plan(context, ids, snapshot)
    }
    return views
  }

  /**
   * Whether the numbers still describe the day the user is standing in.
   *
   * "Due today" and the habit ring are tallied for one calendar day, so at
   * midnight they quietly stop being about today without changing a digit. The
   * device's zone is the closest this process can get — the app's own timezone
   * setting lives in a database the widget cannot open.
   */
  private fun describesToday(snapshot: WidgetSnapshot): Boolean {
    if (snapshot.publishedAt <= 0L) return false
    val zone = ZoneId.systemDefault()
    val published = Instant.ofEpochMilli(snapshot.publishedAt).atZone(zone).toLocalDate()
    return published == LocalDate.now(zone)
  }

  private fun RemoteViews.plan(context: Context, ids: FaceIds, snapshot: WidgetSnapshot) {
    setViewVisibility(ids.notice, View.GONE)
    setViewVisibility(ids.plan, View.VISIBLE)

    val next = snapshot.next
    if (next != null) {
      setTextViewText(ids.eyebrow, "NEXT")
      setViewVisibility(ids.time, View.VISIBLE)
      setTextViewText(ids.time, clock(context, next.startsAt))
      setTextViewText(ids.title, next.title.ifBlank { "Untitled" })

      val aside = listOfNotNull(
        next.leaveAt?.let { "Leave ${clock(context, it)}" },
        next.location,
      )
      line(ids.aside, aside.joinToString("  ·  ").ifEmpty { null })
    } else {
      setTextViewText(ids.eyebrow, "TODAY")
      setViewVisibility(ids.time, View.GONE)
      setTextViewText(ids.title, "Nothing else scheduled")
      line(ids.aside, null)
    }

    // Zeros are true here but say nothing, so they are dropped rather than
    // padded out — except when every count is empty, where an explicit "all
    // clear" is the difference between a calm day and a broken widget.
    val nothingCounted =
      snapshot.dueToday == 0 && snapshot.overdue == 0 && snapshot.habitsTotal == 0
    line(
      ids.due,
      when {
        snapshot.dueToday > 0 -> "${snapshot.dueToday} due"
        nothingCounted -> "All clear"
        else -> null
      },
    )
    line(ids.overdue, if (snapshot.overdue > 0) "${snapshot.overdue} overdue" else null)
    line(
      ids.habits,
      if (snapshot.habitsTotal > 0) "${snapshot.habitsDone}/${snapshot.habitsTotal} habits" else null,
    )
    if (snapshot.habitsTotal > 0) {
      // "2/3" is read out as "two slash three" otherwise.
      setContentDescription(ids.habits, "${snapshot.habitsDone} of ${snapshot.habitsTotal} habits done")
    }
  }

  private fun RemoteViews.notice(ids: FaceIds, title: String, body: String) {
    setViewVisibility(ids.plan, View.GONE)
    setViewVisibility(ids.notice, View.VISIBLE)
    setTextViewText(ids.noticeTitle, title)
    setTextViewText(ids.noticeBody, body)
  }

  /** A view with nothing to say is removed, not left holding an empty string. */
  private fun RemoteViews.line(id: Int, text: String?) {
    if (text == null) {
      setViewVisibility(id, View.GONE)
      return
    }
    setViewVisibility(id, View.VISIBLE)
    setTextViewText(id, text)
  }

  /** Honours the device's 12/24-hour setting, which is why the wire carries epoch ms. */
  private fun clock(context: Context, epochMillis: Long): String =
    DateFormat.getTimeFormat(context).format(Date(epochMillis))

  private fun openApp(context: Context): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(TAP_TARGET))
      .setPackage(context.packageName)
    return PendingIntent.getActivity(
      context,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  /**
   * The widget's resources are written into the app module by
   * `plugins/withRidikAndroidWidget.js`, and an Android library cannot see the
   * app's `R` — the dependency only points the other way. So they are looked up
   * by name. Nothing can strip them out from under this: the manifest names the
   * provider XML, the provider XML names the layout, and the layout names every
   * id below, so the whole set is reachable from the manifest.
   */
  private class FaceIds(context: Context) {
    private val resources = context.resources
    private val pkg = context.packageName

    val layout = resources.getIdentifier("ridik_widget", "layout", pkg)
    val plan = id("ridik_widget_plan")
    val eyebrow = id("ridik_widget_eyebrow")
    val time = id("ridik_widget_time")
    val title = id("ridik_widget_title")
    val aside = id("ridik_widget_aside")
    val due = id("ridik_widget_due")
    val overdue = id("ridik_widget_overdue")
    val habits = id("ridik_widget_habits")
    val notice = id("ridik_widget_notice")
    val noticeTitle = id("ridik_widget_notice_title")
    val noticeBody = id("ridik_widget_notice_body")

    private fun id(name: String) = resources.getIdentifier(name, "id", pkg)
  }
}
