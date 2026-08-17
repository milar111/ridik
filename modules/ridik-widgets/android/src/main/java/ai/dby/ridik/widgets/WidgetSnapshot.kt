package ai.dby.ridik.widgets

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

internal data class HabitRow(
  val name: String,
  val doneToday: Boolean,
  val streak: Int,
  val longestStreak: Int,
  /**
   * 35 characters of '0' or '1', oldest first, the last one being the day this
   * snapshot describes. A string rather than a list of booleans because it is a
   * third of the bytes and it reads as a picture in a failing test.
   */
  val history: String,
)

internal data class ListRow(val text: String, val done: Boolean)

/**
 * One checklist, already chosen by the app — the first with anything open on it.
 *
 * `open` and `total` are both counted *before* the rows are capped, so the header
 * can say "4 OF 12" and the all-ticked line "All twelve done." about a list of
 * twelve. Counting the rows instead is counting the six that fitted.
 */
internal data class Checklist(
  val name: String,
  val open: Int,
  val total: Int,
  val rows: List<ListRow>,
)

/**
 * The day, as a strip of half-hour cells.
 *
 * The widget draws this and computes "now" from its *own* clock, so the strip
 * burns down between publishes without anything being woken. That is why the
 * window is fixed rather than fitted to the day's events: a strip that rescaled
 * whenever a meeting was added would be a different picture at 09:00 and 21:00,
 * and the shape of the day is the thing being read.
 */
internal data class WidgetDay(
  /** 'YYYY-MM-DD' — the day these numbers describe, in `WidgetSnapshot.zone`. */
  val date: String,
  /** Minutes past local midnight of cell 0. */
  val startMinute: Int,
  /** Minutes per cell. Thirty, unless the waking window in Settings says otherwise. */
  val cellMinutes: Int,
  /** One heat character per cell, earliest first. */
  val load: String,
  /**
   * '1' where a new booking begins, '0' elsewhere.
   *
   * Without it two back-to-back meetings are four adjacent claimed cells and
   * read as one long block — a different and wrong answer to "how is my
   * afternoon". The face leaves a hairline of ground before each '1'.
   */
  val breaks: String,
  /** Index into `load` of the next thing's first cell, or -1. */
  val nextCell: Int,
  /** Minutes of the whole window with nothing in them. Never "from now" — see §4. */
  val freeMinutes: Int,
)

/**
 * The month, as a plate of one cell per day.
 *
 * Load only ever reaches `mid` here: `hot` is reserved for today, everywhere in
 * the family, and a month with a hot cell on the 3rd and another on the 19th has
 * no focus at all.
 */
internal data class WidgetMonth(
  /** 'YYYY-MM'. */
  val month: String,
  /** 1 = Monday. Which column the grid starts on. */
  val weekStartsOn: Int,
  /** One heat character per day, the 1st first. Only '0', '1' or '2'. */
  val load: String,
  /**
   * Day of the month that was today *when this was published*, or 0.
   *
   * Kept for the wire and deliberately not drawn from: it is stale the moment
   * the day turns, and this is the one face meant to survive a week untouched.
   * `plate` recomputes the day of the month on the device, in `zone`.
   */
  val today: Int,
)

/**
 * Whether the user has ever set each thing up.
 *
 * The difference between "you have done all your habits" and "you have never
 * added a habit" — which render identically without it, and that single missing
 * distinction is most of why an untouched app's widgets look broken.
 */
internal data class WidgetConfigured(
  val calendar: Boolean,
  val tasks: Boolean,
  val habits: Boolean,
  val lists: Boolean,
)

/**
 * The Kotlin half of `WidgetSnapshot` in `src/services/widgets/snapshot.ts`.
 *
 * Hand-rolled against `org.json` rather than pulled through a serialisation
 * library: the payload arrives from code in this same repo, and a widget's cold
 * start should not have to load a reflection framework to draw six lines of
 * text.
 *
 * Every read is total — a missing array is an empty one, a missing number is
 * zero, a missing section is its cold equivalent. The version gate above it is
 * what guarantees the shape; this is what guarantees that a surprise inside a
 * known shape draws a short face rather than throwing away the whole snapshot.
 */
internal data class WidgetSnapshot(
  val version: Int,
  val publishedAt: Long,
  /**
   * The IANA zone the day was computed in.
   *
   * Never guessed. `ZoneId.systemDefault()` is right until the user is
   * travelling, and then every face is wrong by hours while looking entirely
   * plausible — which is exactly the failure worth carrying a field for.
   */
  val zone: String,
  /**
   * The ember the user picked, as a name — never a colour.
   *
   * A colour on the wire would be resolved against whichever scheme the *app*
   * happened to be in when it published, and the launcher draws the tile
   * against its own; §5 is why `scheme` is deliberately not in the payload, and
   * the same argument makes a colour one unthinkable. What travels is one of
   * three names, and every resource it selects exists twice in the table with
   * the launcher choosing the half.
   *
   * Always one of `EMBERS`. A payload from a build that does not send this, or
   * that sends something this build has never heard of, draws the default —
   * which is the current design, and the only wrong answer that is still a
   * widget.
   */
  val ember: String,
  val day: WidgetDay,
  val month: WidgetMonth,
  val configured: WidgetConfigured,
  val next: NextUp?,
  val dueToday: Int,
  val overdue: Int,
  /** Days overdue per open task, oldest first. 0 is "due today". */
  val taskAges: List<Int>,
  val taskRows: List<TaskRow>,
  val habitsDone: Int,
  val habitsTotal: Int,
  val habitRows: List<HabitRow>,
  val agenda: List<AgendaRow>,
  /** All-day titles. A calendar widget that drops these loses whole days. */
  val allDay: List<String>,
  val list: Checklist?,
) {
  companion object {
    /**
     * Must track `WIDGET_SNAPSHOT_VERSION`. Anything else is not readable here.
     *
     * 4 adds `ember`. The bump is what stops an older widget from decoding a
     * newer payload into half a face: it draws "Ridik was updated." instead,
     * which is the whole point of the field.
     */
    const val SUPPORTED_VERSION = 4

    /**
     * What a fresh install draws, and the answer to every question this file
     * cannot resolve.
     *
     * The mirror of `DEFAULT_EMBER` in `src/ui/theme.ts`, and of the layouts
     * and drawables `plugins/withRidikAndroidWidget.js` writes for it — that
     * plugin's `EMBER_NAMES` is the other end of `EMBERS` below.
     */
    const val DEFAULT_EMBER = "ember"

    /**
     * Checked rather than trusted, because the name is a *resource name*.
     *
     * An unrecognised string would be pasted straight into
     * `Resources.getIdentifier`, resolve to 0, and leave the widget with no
     * layout at all — a blank tile, with nothing failing anywhere. The set is
     * the cheapest possible guard against a payload from a build that ships an
     * ember this one has never generated.
     */
    private val EMBERS = setOf(DEFAULT_EMBER, "kiln", "rust")

    /** 07:00, in minutes, for a payload that somehow carries no window. */
    private const val DEFAULT_START_MINUTE = 7 * 60

    /** Thirty minutes per cell is the whole design; see `DAY_CELL_MINUTES`. */
    private const val DEFAULT_CELL_MINUTES = 30

    /**
     * A day with nothing in it rather than no day at all.
     *
     * The faces are required to draw their graphic in every empty state, so
     * "there was no `day` object" has to arrive here as cold cells — never as a
     * missing strip, which would be the one shape the design does not have.
     */
    private val COLD_DAY = WidgetDay(
      date = "",
      startMinute = DEFAULT_START_MINUTE,
      cellMinutes = DEFAULT_CELL_MINUTES,
      load = "",
      breaks = "",
      nextCell = -1,
      freeMinutes = 0,
    )

    private val COLD_MONTH = WidgetMonth(month = "", weekStartsOn = 1, load = "", today = 0)

    private val NOTHING_CONFIGURED =
      WidgetConfigured(calendar = false, tasks = false, habits = false, lists = false)

    /** Null for anything this cannot make sense of — the face says so rather than guessing. */
    fun parse(json: String): WidgetSnapshot? = try {
      val root = JSONObject(json)
      val tasks = root.optJSONObject("tasks")
      val habits = root.optJSONObject("habits")
      WidgetSnapshot(
        version = root.optInt("version", 0),
        publishedAt = root.optLong("publishedAt", 0L),
        zone = root.string("zone") ?: "",
        // Read outside the version gate on purpose: the face picks its layout
        // before it knows whether it can read the rest, and the "Ridik was
        // updated." tile should still be the colour the user chose.
        ember = root.string("ember")?.takeIf { it in EMBERS } ?: DEFAULT_EMBER,
        day = root.optJSONObject("day")?.let { parseDay(it) } ?: COLD_DAY,
        month = root.optJSONObject("month")?.let { parseMonth(it) } ?: COLD_MONTH,
        configured = root.optJSONObject("configured")?.let { parseConfigured(it) }
          ?: NOTHING_CONFIGURED,
        next = root.optJSONObject("next")?.let { parseNext(it) },
        dueToday = tasks?.optInt("dueToday", 0) ?: 0,
        overdue = tasks?.optInt("overdue", 0) ?: 0,
        taskAges = tasks?.optJSONArray("ages").ints(),
        taskRows = tasks?.optJSONArray("rows").map { parseTask(it) },
        habitsDone = habits?.optInt("done", 0) ?: 0,
        habitsTotal = habits?.optInt("total", 0) ?: 0,
        habitRows = habits?.optJSONArray("rows").map { parseHabit(it) },
        agenda = root.optJSONArray("agenda").map { parseAgenda(it) },
        allDay = root.optJSONArray("allDay").strings(),
        list = root.optJSONObject("list")?.let { parseList(it) },
      )
    } catch (_: JSONException) {
      null
    }

    private fun parseDay(day: JSONObject) = WidgetDay(
      date = day.string("date") ?: "",
      startMinute = day.optInt("startMinute", DEFAULT_START_MINUTE),
      // Coerced rather than defaulted: a zero here would divide by zero in every
      // face that asks which cell "now" falls in.
      cellMinutes = day.optInt("cellMinutes", DEFAULT_CELL_MINUTES).coerceAtLeast(1),
      load = day.digits("load"),
      breaks = day.digits("breaks"),
      nextCell = day.optInt("nextCell", -1),
      freeMinutes = day.optInt("freeMinutes", 0),
    )

    private fun parseMonth(month: JSONObject) = WidgetMonth(
      month = month.string("month") ?: "",
      weekStartsOn = month.optInt("weekStartsOn", 1),
      load = month.digits("load"),
      today = month.optInt("today", 0),
    )

    private fun parseConfigured(configured: JSONObject) = WidgetConfigured(
      calendar = configured.optBoolean("calendar", false),
      tasks = configured.optBoolean("tasks", false),
      habits = configured.optBoolean("habits", false),
      lists = configured.optBoolean("lists", false),
    )

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
      longestStreak = row.optInt("longestStreak", 0),
      history = row.digits("history"),
    )

    private fun parseList(list: JSONObject): Checklist {
      val rows = list.optJSONArray("rows")
        .map { ListRow(it.string("text") ?: "", it.optBoolean("done")) }
      return Checklist(
        name = list.string("name") ?: "List",
        open = list.optInt("open", 0),
        // Never fewer than the rows in hand: a total that arrived smaller than
        // what it is supposed to count is not a total, and "3 OF 2" is worse
        // than counting the rows.
        total = list.optInt("total", rows.size).coerceAtLeast(rows.size),
        rows = rows,
      )
    }

    /** An array of objects, skipping anything in it that is not one. */
    private fun <T> JSONArray?.map(each: (JSONObject) -> T): List<T> {
      if (this == null || length() == 0) return emptyList()
      val out = ArrayList<T>(length())
      for (index in 0 until length()) {
        optJSONObject(index)?.let { out.add(each(it)) }
      }
      return out
    }

    private fun JSONArray?.ints(): List<Int> {
      if (this == null || length() == 0) return emptyList()
      val out = ArrayList<Int>(length())
      for (index in 0 until length()) out.add(optInt(index, 0))
      return out
    }

    /** Blanks are dropped: an all-day event with no title is not a line worth drawing. */
    private fun JSONArray?.strings(): List<String> {
      if (this == null || length() == 0) return emptyList()
      val out = ArrayList<String>(length())
      for (index in 0 until length()) {
        val value = optString(index).trim()
        if (value.isNotEmpty() && value != "null") out.add(value)
      }
      return out
    }

    /**
     * `optString` renders an explicit JSON null as the four characters "null",
     * which would put the word on the widget. Several strings in the payload are
     * routinely null, so every read goes through this.
     */
    private fun JSONObject.string(name: String): String? =
      if (isNull(name)) null else optString(name).trim().ifEmpty { null }

    /**
     * A heat string, with anything that is not a digit thrown away.
     *
     * These are drawn a character at a time and indexed by cell, so one stray
     * character would not corrupt a colour — it would silently shift every cell
     * after it by one, which is the kind of wrongness that still looks like a
     * plausible day.
     */
    private fun JSONObject.digits(name: String): String {
      val value = string(name) ?: return ""
      return if (value.all { it in '0'..'9' }) value else value.filter { it in '0'..'9' }
    }
  }
}
