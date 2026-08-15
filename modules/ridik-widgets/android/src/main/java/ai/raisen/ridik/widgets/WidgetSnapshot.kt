package ai.raisen.ridik.widgets

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** The travel buffer and the place are both optional on the wire. */
internal data class NextUp(
  val title: String,
  val startsAt: Long,
  val leaveAt: Long?,
  val location: String?,
)

/** One thing still to happen today. Travel buffers are dropped by the publisher. */
internal data class AgendaRow(
  val title: String,
  val startsAt: Long,
  val endsAt: Long,
  /** "event" or "class" — a class is labelled, an event is not. */
  val kind: String,
  val location: String?,
)

/** `dueAt` is null for a task due today that carries no time. */
internal data class TaskRow(val title: String, val dueAt: Long?, val overdue: Boolean)

internal data class HabitRow(val name: String, val doneToday: Boolean, val streak: Int)

internal data class ListRow(val text: String, val done: Boolean)

/** One checklist, already chosen by the app — the first with anything open on it. */
internal data class Checklist(val name: String, val open: Int, val rows: List<ListRow>)

/**
 * The Kotlin half of `WidgetSnapshot` in `src/services/widgets/snapshot.ts`.
 *
 * Hand-rolled against `org.json` rather than pulled through a serialisation
 * library: the payload arrives from code in this same repo, and a widget's cold
 * start should not have to load a reflection framework to draw six lines of
 * text.
 *
 * Every read is total — a missing array is an empty one, a missing number is
 * zero. The version gate above it is what guarantees the shape; this is what
 * guarantees that a surprise inside a known shape draws a short face rather
 * than throwing away the whole snapshot.
 */
internal data class WidgetSnapshot(
  val version: Int,
  val publishedAt: Long,
  /** The IANA zone the day was computed in. Never guess this — see `describesToday`. */
  val zone: String,
  val next: NextUp?,
  val dueToday: Int,
  val overdue: Int,
  val taskRows: List<TaskRow>,
  val habitsDone: Int,
  val habitsTotal: Int,
  val habitRows: List<HabitRow>,
  val agenda: List<AgendaRow>,
  val list: Checklist?,
) {
  companion object {
    /** Must track `WIDGET_SNAPSHOT_VERSION`. Anything else is not readable here. */
    const val SUPPORTED_VERSION = 3

    /** Null for anything this cannot make sense of — the face says so rather than guessing. */
    fun parse(json: String): WidgetSnapshot? = try {
      val root = JSONObject(json)
      val tasks = root.optJSONObject("tasks")
      val habits = root.optJSONObject("habits")
      WidgetSnapshot(
        version = root.optInt("version", 0),
        publishedAt = root.optLong("publishedAt", 0L),
        zone = root.string("zone") ?: "",
        next = root.optJSONObject("next")?.let { parseNext(it) },
        dueToday = tasks?.optInt("dueToday", 0) ?: 0,
        overdue = tasks?.optInt("overdue", 0) ?: 0,
        taskRows = tasks?.optJSONArray("rows").map { parseTask(it) },
        habitsDone = habits?.optInt("done", 0) ?: 0,
        habitsTotal = habits?.optInt("total", 0) ?: 0,
        habitRows = habits?.optJSONArray("rows").map { parseHabit(it) },
        agenda = root.optJSONArray("agenda").map { parseAgenda(it) },
        list = root.optJSONObject("list")?.let { parseList(it) },
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

    private fun parseAgenda(row: JSONObject) = AgendaRow(
      title = row.string("title") ?: "Untitled",
      startsAt = row.optLong("startsAt", 0L),
      endsAt = row.optLong("endsAt", 0L),
      kind = row.string("kind") ?: "event",
      location = row.string("location"),
    )

    private fun parseTask(row: JSONObject) = TaskRow(
      title = row.string("title") ?: "Untitled",
      dueAt = if (row.isNull("dueAt")) null else row.optLong("dueAt").takeIf { it > 0L },
      overdue = row.optBoolean("overdue", false),
    )

    private fun parseHabit(row: JSONObject) = HabitRow(
      name = row.string("name") ?: "Untitled",
      doneToday = row.optBoolean("doneToday", false),
      streak = row.optInt("streak", 0),
    )

    private fun parseList(list: JSONObject) = Checklist(
      name = list.string("name") ?: "List",
      open = list.optInt("open", 0),
      rows = list.optJSONArray("rows").map { ListRow(it.string("text") ?: "", it.optBoolean("done")) },
    )

    /** An array of objects, skipping anything in it that is not one. */
    private fun <T> JSONArray?.map(each: (JSONObject) -> T): List<T> {
      if (this == null || length() == 0) return emptyList()
      val out = ArrayList<T>(length())
      for (index in 0 until length()) {
        optJSONObject(index)?.let { out.add(each(it)) }
      }
      return out
    }

    /**
     * `optString` renders an explicit JSON null as the four characters "null",
     * which would put the word on the widget. Several strings in the payload
     * are routinely null, so every read goes through this.
     */
    private fun JSONObject.string(name: String): String? =
      if (isNull(name)) null else optString(name).trim().ifEmpty { null }
  }
}
