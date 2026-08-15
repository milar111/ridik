package ai.raisen.ridik.widgets

import org.json.JSONException
import org.json.JSONObject

/** The travel buffer and the place are both optional on the wire. */
internal data class NextUp(
  val title: String,
  val startsAt: Long,
  val leaveAt: Long?,
  val location: String?,
)

/**
 * The Kotlin half of `WidgetSnapshot` in `src/services/widgets/snapshot.ts`.
 *
 * Hand-rolled against `org.json` rather than pulled through a serialisation
 * library: the payload is nine fields, it arrives from code in this same repo,
 * and a widget's cold start should not have to load a reflection framework to
 * draw four lines of text.
 */
internal data class WidgetSnapshot(
  val version: Int,
  val publishedAt: Long,
  val next: NextUp?,
  val dueToday: Int,
  val overdue: Int,
  val habitsDone: Int,
  val habitsTotal: Int,
) {
  companion object {
    /** Must track `WIDGET_SNAPSHOT_VERSION`. Anything else is not readable here. */
    const val SUPPORTED_VERSION = 1

    /** Null for anything this cannot make sense of — the face says so rather than guessing. */
    fun parse(json: String): WidgetSnapshot? = try {
      val root = JSONObject(json)
      val tasks = root.optJSONObject("tasks")
      val habits = root.optJSONObject("habits")
      WidgetSnapshot(
        version = root.optInt("version", 0),
        publishedAt = root.optLong("publishedAt", 0L),
        next = root.optJSONObject("next")?.let { parseNext(it) },
        dueToday = tasks?.optInt("dueToday", 0) ?: 0,
        overdue = tasks?.optInt("overdue", 0) ?: 0,
        habitsDone = habits?.optInt("done", 0) ?: 0,
        habitsTotal = habits?.optInt("total", 0) ?: 0,
      )
    } catch (_: JSONException) {
      null
    }

    private fun parseNext(next: JSONObject) = NextUp(
      title = next.string("title") ?: "",
      startsAt = next.optLong("startsAt", 0L),
      leaveAt = if (next.isNull("leaveAt")) null else next.optLong("leaveAt").takeIf { it > 0L },
      location = next.string("location"),
    )

    /**
     * `optString` renders an explicit JSON null as the four characters "null",
     * which would put the word on the widget. Both nullable strings in the
     * payload are routinely null, so every read goes through this.
     */
    private fun JSONObject.string(name: String): String? =
      if (isNull(name)) null else optString(name).trim().ifEmpty { null }
  }
}
