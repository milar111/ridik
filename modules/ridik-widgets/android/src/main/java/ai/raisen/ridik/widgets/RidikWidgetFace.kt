package ai.raisen.ridik.widgets

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Today: the day as a strip of heat, and the next thing on it.
 *
 * RemoteViews is a list of "set this property on that view id", replayed by the
 * launcher in its own process — so there is no `findViewById`, no custom view
 * and no measuring here. The layout is fixed; this decides which of its panes is
 * visible, which cells differ from cold, and what the words are.
 *
 * The notice pane is for the two states where there is genuinely nothing to
 * draw: nothing published, and a payload this build cannot read. A day that has
 * ended is not one of them — it is a strip burned all the way down with a
 * sentence underneath, because Android redraws at most every thirty minutes and
 * a notice here empties the home screen from midnight until the app is opened.
 */
internal object RidikWidgetFace {
  /** Today is the screen this face summarises, so it is where a tap lands. */
  private const val TAP_TARGET = "ridik:///today"

  /**
   * When "the day is yours" becomes "winding down".
   *
   * Five in the afternoon, not sunset and not the end of the window: the
   * sentence is about whether there is still a day left to spend, and that stops
   * being true well before the strip runs out.
   */
  private const val EVENING_MINUTE = 17 * 60

  /** Null when the layout is missing, which means there is nothing to draw at all. */
  fun build(context: Context, widthDp: Int, heightDp: Int): RemoteViews? {
    // Today has no large face: a strip and one readout do not want 300dp of
    // height, and stretching them would leave a band of empty ground under the
    // ruler. Large gets the medium drawing.
    val size = sizeOf(widthDp, heightDp)
    // Read before the layout is picked, not after: the ember is part of the
    // layout's name. RemoteViews cannot recolour a `TextView` on a build that
    // ships to API 26 — and a colour resolved in this process would be resolved
    // against this process's night mode, which is the bug that cost a day — so
    // an ember-tinted word is a different file, exactly as a 12-hour clock is.
    val snapshot = WidgetSnapshotStore.read(context)?.let { WidgetSnapshot.parse(it) }
    val base = if (size == WidgetSize.SMALL) "ridik_today_small" else "ridik_today_medium"
    val ids = idsFor(context, base, snapshot?.ember ?: WidgetSnapshot.DEFAULT_EMBER)
    if (ids.layout == 0) return null

    val views = RemoteViews(context.packageName, ids.layout)
    views.setOnClickPendingIntent(android.R.id.background, openApp(context))

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
        views.today(context, ids, snapshot, size, zone, describesToday(snapshot, zone))
      }
    }
    return views
  }

  private fun RemoteViews.today(
    context: Context,
    ids: WidgetIds,
    snapshot: WidgetSnapshot,
    size: WidgetSize,
    zone: ZoneId,
    fresh: Boolean,
  ) {
    showBody(ids)

    val now = ZonedDateTime.now(zone)
    val slots = Slots.day(size)
    // A day that has ended is read from past its own last cell, so the whole
    // strip burns down. The step in the silhouette is the message: this is a day
    // with nothing left in it, which is exactly what yesterday is.
    val nowMinutes = if (fresh) minutesOf(now) else endOfDay(snapshot.day, slots)

    head(
      ids,
      "TODAY  ${dayLabel(describedDate(snapshot, zone))}",
      // Every one of those counts is a claim about a day that has already ended.
      if (fresh) count(snapshot) else null,
    )
    // Today is the one face whose hot cell is unambiguous: there is no plate
    // here to compete for it, so the next thing keeps it.
    element(context, ids, snapshot.day, slots, nowMinutes)

    if (!fresh) {
      setViewVisibility(ids.next, View.GONE)
      say(ids, "Yesterday's plan.", "Open Ridik to bring today's in.")
      return
    }

    val next = snapshot.next
    if (next != null) {
      setViewVisibility(ids.next, View.VISIBLE)
      setTextViewText(ids.readout, timeFormat(context, zone).clock(next.startsAt))
      setTextViewText(ids.nextTitle, next.title.ifBlank { "Untitled" })
      say(ids, null, null)
      leaveLine(context, ids, next)
      return
    }

    // Nothing ahead. The strip is still drawn — every empty state in this family
    // draws its graphic — and the words go where the readout was.
    setViewVisibility(ids.next, View.GONE)
    // Dropped rather than printed when it rounds to nothing: "0m unclaimed"
    // under "The day is yours" is the widget arguing with itself, and there is
    // no copy for that state because it is not one the design has.
    val free = unclaimedMinutes(snapshot.day, nowMinutes).takeIf { it > 0 }?.let { spanText(it) }
    when {
      // `configured` is what separates "you did everything" from "you have never
      // set this up". Without it those two render identically, which is most of
      // the reason an untouched install looks broken rather than empty.
      !snapshot.configured.calendar &&
        !snapshot.configured.tasks &&
        !snapshot.configured.habits ->
        say(ids, "Nothing in here yet.", "Hold the mic and say what's on today.")
      nowMinutes < EVENING_MINUTE -> say(ids, "The day is yours.", free?.let { "$it unclaimed." })
      else -> say(ids, "Winding down.", free?.let { "$it left." })
    }
  }

  /**
   * "leave in 34 min", then "leave now", then nothing.
   *
   * A `Chronometer` counts *past* its base as readily as down to it, so one left
   * running unattended reads "leave in -04:31" — on the widget whose entire job
   * is punctuality, for as long as thirty minutes. Two things stop that: the
   * countdown is only ever started while there is time left on it, and a one-shot
   * alarm at the buffer's end brings the redraw forward to the instant it runs
   * out. iOS covers the same moment with a timeline entry.
   *
   * Past it, the line is "leave now" until the thing has actually started, and
   * after that only the place — nobody needs to be told to leave for a meeting
   * they are already in.
   */
  private fun RemoteViews.leaveLine(context: Context, ids: WidgetIds, next: NextUp) {
    val now = System.currentTimeMillis()
    val leaveAt = next.leaveAt?.takeIf { next.startsAt > now }

    if (leaveAt != null && leaveAt > now) {
      countdown(ids, leaveAt, next.location)
      setViewVisibility(ids.nextSub, View.GONE)
      LeaveAlarm.at(context, leaveAt)
      return
    }

    setViewVisibility(ids.timer, View.GONE)
    val aside = next.location?.takeIf { it.isNotBlank() }
    line(
      ids.nextSub,
      when {
        leaveAt == null -> aside
        aside == null -> "leave now"
        else -> "leave now  ·  $aside"
      },
    )
  }

  /**
   * One number, in strict priority: overdue, then due today, then the habits
   * fraction. Never two.
   *
   * Two numbers in a header is arithmetic the reader has to do at arm's length,
   * and the second one is always the one that does not matter today.
   */
  private fun count(snapshot: WidgetSnapshot): String? = when {
    snapshot.overdue > 0 -> "${snapshot.overdue} LATE"
    snapshot.dueToday > 0 -> "${snapshot.dueToday} DUE"
    snapshot.habitsTotal > 0 -> "${snapshot.habitsDone}/${snapshot.habitsTotal}"
    else -> null
  }

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
}
