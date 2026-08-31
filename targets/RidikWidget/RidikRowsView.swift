import SwiftUI
import WidgetKit

/**
 The two faces that are still lists — Tasks and List (WIDGETS §3.4, §3.5).

 They keep their own file because they are the same shape: a header, one graphic
 or none, and rows of `lead · text`. The other three are drawings with a caption
 and have nothing left in common with these beyond the cell they are built from.
 */

// MARK: - Tasks

/**
 Tasks — debt as a strip, oldest left (WIDGETS §3.4).

 The axis is age, not clock time. `due` in the tool contract is a full
 `YYYY-MM-DDTHH:mm`, so the model invents an hour whenever the user did not say
 one, and plotting that as a position would render fiction as data. How late
 something is was never guessed, which is why it is the thing drawn.
 */
struct RidikTasksView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var colorScheme

  let entry: RidikEntry

  var body: some View {
    let palette = RidikPalette.of(scheme: colorScheme, ember: entry.face.ember)

    content(palette)
      .ridikTilePadding()
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .ridikGround(palette)
      .widgetURL(Route.tasks)
  }

  private var small: Bool { family == .systemSmall }

  @ViewBuilder
  private func content(_ palette: RidikPalette) -> some View {
    switch entry.face {
    case .ready(let snapshot):
      face(snapshot, palette: palette, stale: false)
    case .stale(let snapshot):
      face(snapshot, palette: palette, stale: true)
    case .blank(let reason):
      // The whole tile, for the two states where there is genuinely nothing to
      // draw — WIDGETS §4. "Nothing open" is *not* one of them and keeps its
      // full strip of cold cells below; this is "the app has never published",
      // where a gauge reading zero would be a reading rather than an absence.
      NoticePane(reason: reason, palette: palette, compact: small)
    }
  }

  @ViewBuilder
  private func face(_ snapshot: WidgetSnapshot, palette: RidikPalette, stale: Bool) -> some View {
    let tasks = snapshot.tasks

    VStack(alignment: .leading, spacing: 0) {
      TileHeader(
        eyebrow: "TASKS",
        // Overdue outranks due: it is the number that should pull the eye, and
        // showing both would spend the header line on arithmetic.
        trailing: stale ? nil : header(tasks),
        palette: palette
      )

      strip(stale ? [] : tasks.ages, palette: palette)

      if !stale, tasks.open > 0 {
        footer(tasks, palette: palette)
      }

      // A medium tile holds a strip, a readout and three rows in 131 points and
      // has nothing spare; a small one holds two rows and has forty, which is
      // where its readout's extra eight points came from.
      Spacer(minLength: small ? 6 : 2)

      rowsOrNote(snapshot, palette: palette, stale: stale)
    }
  }

  private func header(_ tasks: WidgetSnapshot.Tasks) -> String? {
    if tasks.overdue > 0 { return "\(tasks.overdue) LATE" }
    if tasks.dueToday > 0 { return "\(tasks.dueToday) DUE" }
    return nil
  }

  /**
   Always the full strip, and always the full width of the tile.

   The cap is the number of cells, not the number of tasks: a gauge has an
   extent, and two lit cells followed by bare ground would make the tile with
   two tasks on it look *less* finished than the tile with none. The cells
   divide the width rather than sitting at a fixed 10 with the remainder left as
   ground, which is what Android's weighted cells have always done.
   */
  private func strip(_ ages: [Int], palette: RidikPalette) -> some View {
    DebtStrip(
      ages: ages,
      cap: small ? 12 : 24,
      palette: palette,
      maxCellWidth: small ? 11 : 13,
      // Twelve cells across a small tile cannot afford three points of ground
      // between them; twenty-four across a medium one can, and need it — at two
      // the strip read as one bar with notches in it rather than as a count.
      gap: small ? 2 : 3
    )
    // The height is the track's, well and all. The cells get six less.
    .frame(height: small ? 22 : 24)
    .padding(.top, small ? 8 : 6)
  }

  /**
   The count, as a reading rather than as a caption.

   This line used to be two 12pt phrases at opposite ends of the tile, which is
   the "three evenly spaced stat pills" shape WIDGETS §1 bans with one pill
   removed: nothing on it was the answer, so the eye had to read both and pick.
   How many are open is the number this face exists for, so it is set as one and
   "oldest 9d" trails it as the footnote it always was.

   A small tile can carry it much larger — two rows and a twelve-cell strip
   leave nearly forty points spare there, which is exactly the air the brief
   asked for and there is nothing else worth spending it on.
   */
  private func footer(_ tasks: WidgetSnapshot.Tasks, palette: RidikPalette) -> some View {
    let oldest = tasks.ages.first ?? 0
    return HeroCount(
      value: "\(tasks.open)",
      caption: "open",
      // Dropped on small, where a 26pt reading and a footnote do not both fit
      // in 119 points and the footnote came back as "oldes…". Nothing is lost:
      // the first row's own lead already reads `9d`, and it is the same task.
      trailing: !small && oldest > 0 ? "oldest \(oldest)d" : nil,
      palette: palette,
      size: small ? 26 : 18
    )
    .padding(.top, small ? 6 : 4)
  }

  @ViewBuilder
  private func rowsOrNote(_ snapshot: WidgetSnapshot, palette: RidikPalette, stale: Bool)
    -> some View
  {
    if stale {
      EmptyNote(
        headline: "Yesterday's plan.",
        sub: "Open Ridik to bring today's in.",
        palette: palette,
        compact: small
      )
    } else if !snapshot.configured.tasks {
      EmptyNote(
        headline: "No tasks yet.",
        sub: "Say \u{201C}remind me to call the landlord Friday\u{201D}.",
        palette: palette,
        compact: small
      )
    } else if snapshot.tasks.open == 0 {
      EmptyNote(
        headline: "Clear.",
        sub: "Nothing due, nothing late.",
        palette: palette,
        compact: small
      )
    } else {
      let rows = Array(taskRows(snapshot).prefix(small ? 2 : 3))
      VStack(alignment: .leading, spacing: small ? 8 : 6) {
        ForEach(rows) { row in
          RowLine(
            row: row,
            palette: palette,
            wide: !small,
            leadWidth: ridikLeadWidth(for: rows, wide: !small)
          )
        }
      }
    }
  }

  private func taskRows(_ snapshot: WidgetSnapshot) -> [RidikRow] {
    snapshot.tasks.rows.map { task in
      // Never the word "late": the payload has always carried the real date, so
      // the row can say how late instead of that it is.
      let lead: RidikRow.Lead
      if task.overdue, let due = task.dueDate {
        lead = .text("\(RidikFormat.daysLate(due, at: entry.date, snapshot.calendar))d")
      } else if let due = task.dueDate, !task.overdue {
        lead = .time(due, snapshot.timeZone)
      } else {
        // Only reachable for a task with no due date at all, which is the one
        // case where there is no number to print and still no excuse for "late".
        lead = .text("·")
      }

      let when: String?
      if task.overdue, let due = task.dueDate {
        when = "\(RidikFormat.daysLate(due, at: entry.date, snapshot.calendar)) days late"
      } else if let due = task.dueDate {
        when = "due \(RidikFormat.spokenTime(due, snapshot.timeZone))"
      } else {
        when = nil
      }

      return RidikRow(
        id: task.id,
        lead: lead,
        text: task.title,
        spoken: [task.title, when].compactMap { $0 }.joined(separator: ", ")
      )
    }
  }
}

// MARK: - List

/**
 List — the quiet one (WIDGETS §3.5).

 No cells, by decision. A checklist has no time axis and inventing one would be
 decoration; one tile without a graphic is what makes the other four read as
 chosen rather than as a house style applied everywhere. The marks are the
 exception, and they are the family's primitive at its quietest.
 */
struct RidikListView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var colorScheme

  let entry: RidikEntry

  var body: some View {
    let palette = RidikPalette.of(scheme: colorScheme, ember: entry.face.ember)

    content(palette)
      .ridikTilePadding()
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .ridikGround(palette)
      .widgetURL(destination)
  }

  private var small: Bool { family == .systemSmall }
  private var large: Bool { family == .systemLarge }

  /// The tile opens the list it was showing, not the pane in general.
  private var destination: URL {
    guard let list = entry.face.snapshot?.list else { return Route.lists }
    return Route.list(named: list.name)
  }

  @ViewBuilder
  private func content(_ palette: RidikPalette) -> some View {
    switch entry.face {
    case .ready(let snapshot), .stale(let snapshot):
      // Deliberately no staleness branch. A checklist is not a day: "bolts,
      // threadlock, sanding discs" is exactly as true tomorrow, and telling
      // someone their shopping list is out of date would be a lie about it.
      if let list = snapshot.list, snapshot.configured.lists {
        face(list, palette: palette)
      } else {
        // An empty state, not a blank one: there is a payload, it simply has no
        // list on it. It keeps its graphic — WIDGETS §4.
        noList(
          headline: "No list yet.",
          sub: "Say \u{201C}add bolts to the hardware list\u{201D}.",
          palette: palette
        )
      }
    case .blank(let reason):
      // Nothing published, or a payload this build cannot read. The marks would
      // be a checklist drawn for a list the extension has never been handed.
      NoticePane(reason: reason, palette: palette, compact: small)
    }
  }

  @ViewBuilder
  private func face(_ list: WidgetSnapshot.Checklist, palette: RidikPalette) -> some View {
    // Enumerated, because a list may hold the same text twice and two rows with
    // the same id are one row to `ForEach` — see `ListRow.id(at:)`.
    let rows = list.rows.enumerated().map { offset, item in
      RidikRow(
        id: item.id(at: offset),
        lead: .mark(item.done),
        text: item.text,
        spent: item.done,
        spoken: "\(item.text), \(item.done ? "done" : "still open")"
      )
    }
    let done = list.open == 0
    // Computed once: it is read by the row list and again by the caption below,
    // and two calls could only ever disagree.
    let ration = rationed(rows, done: done)

    VStack(alignment: .leading, spacing: 0) {
      // The tally is the only number the quiet face has, and it is what the
      // tile is for — "how much of this is left". Set as a reading, like the
      // habits fraction, and for the same reason.
      //
      // Not on small: the eyebrow there is a list *name*, which is the one
      // thing on this face that must never be cut, and `4 OF 12` at 14pt plus
      // a real name is wider than 119 points. Habits' `4/6` is three
      // characters and has no such problem at any size.
      TileHeader(
        eyebrow: list.name.uppercased(),
        trailing: count(list),
        emphasis: !small,
        palette: palette
      )

      // A list with nothing on it yet is not the same as one you have finished,
      // and neither of them is a reason to draw no graphic at all. The marks
      // are this tile's only drawing; leaving them out is what would make it
      // the one face in the family that is a bare sentence on a rectangle.
      Group {
        if rows.isEmpty {
          // The same number of slots a full list draws, spread over the same
          // extent. Fewer marks than rows, stacked at the top of the tile, is
          // an empty face that is a different shape from a populated one.
          MarkColumn(count: capacity(done: false), palette: palette)
        } else {
          // Nine on small, where four rows leave seventeen points spare and the
          // spacing between them *is* the composition — this is the one face
          // with no graphic to carry it, and a checklist set at the density of
          // an agenda reads as a paragraph. Medium keeps seven: five rows and
          // an emphasised tally already fill 131 points, and a row of somebody's
          // list is worth more than the air between two of them.
          // Large tightens to 5: eleven rows plus a header is the whole tile,
          // and the air that makes a four-row list read as a composition is
          // exactly what there is no room for once the list is worth reading.
          VStack(alignment: .leading, spacing: small ? 9 : large ? 5 : 7) {
            ForEach(ration.drawn) { row in
              RowLine(
                row: row,
                palette: palette,
                wide: !small,
                leadWidth: ridikLeadWidth(for: rows, wide: !small)
              )
            }
          }
        }
      }
      .padding(.top, small ? 8 : 6)

      Spacer(minLength: small ? 4 : 2)

      // The rationed-away rows are counted here rather than silently dropped.
      // `4 OF 12` in the header says what is *left*; this says what is already
      // behind you and is not on the tile, which is the half a capped list would
      // otherwise misreport. Checked before `closingLine` because a list with
      // hidden done rows is by definition not an empty or a finished one.
      if ration.hiddenDone > 0 {
        EmptyNote(headline: "+\(ration.hiddenDone) done", palette: palette, compact: small)
      } else if let closing = closingLine(list) {
        // Under the drawing, as §4 requires — the sentence is a caption on the
        // marks, not a replacement for them.
        EmptyNote(headline: closing, palette: palette, compact: small)
      }
    }
  }

  /**
   Still a drawing.

   A full column of cold marks, at the extent a list of the same length would
   occupy: the tile keeps its shape, and the one graphic this face has is the
   one it shows when there is nothing to tick. Four marks bunched at the top was
   the empty tile that reads as a plain card with a sentence on it.
   */
  private func noList(headline: String, sub: String?, palette: RidikPalette) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      TileHeader(eyebrow: "LIST", palette: palette)

      MarkColumn(count: capacity(done: false), palette: palette)
        .padding(.top, 8)

      Spacer(minLength: 6)

      EmptyNote(headline: headline, sub: sub, palette: palette, compact: small)
    }
  }

  /**
   How many rows the tile has room for.

   Eleven on large: 321 points holds that many at 20pt with the header, and this
   is the one face in the family worth reading in full rather than glancing at —
   a shopping list you cannot see the end of is a list you still have to open the
   app for.
   */
  private func capacity(done: Bool) -> Int {
    let rows = large ? 11 : small ? 4 : 5
    // The sentence costs a row when it is there.
    return done ? rows - 1 : rows
  }

  /**
   At eleven rows, the struck-through ones have to be rationed.

   Open-first with everything struck through after it works at five rows because
   you rarely see both halves at once. At eleven you always do, and a list that
   is two-thirds crossed out reads as *finished* when most of it is not — the one
   misreading this face cannot afford, because the whole tile is a tally.

   So the done rows are capped and the rest are counted. Capped rather than
   dropped: the crossed-out rows are the only evidence on the tile that it is
   showing a list somebody is actually working through, and a face that hid them
   entirely would look identical whether it was live or three days stale.

   Only large rations them. Smaller sizes never fit enough rows for the
   proportion to mislead.
   */
  private static let doneRowsOnLarge = 3

  private func rationed(_ rows: [RidikRow], done: Bool) -> (drawn: [RidikRow], hiddenDone: Int) {
    let room = capacity(done: done)
    guard large else { return (Array(rows.prefix(room)), 0) }

    // `snapshot.ts` sorts open before done, so this split needs no predicate of
    // its own — and must not invent one, or the two would disagree about order.
    let open = rows.filter { !$0.spent }
    let finished = rows.filter { $0.spent }

    let openShown = Array(open.prefix(room))
    let roomLeft = max(0, room - openShown.count)
    let doneShown = Array(finished.prefix(min(roomLeft, Self.doneRowsOnLarge)))
    return (openShown + doneShown, finished.count - doneShown.count)
  }

  /**
   `4 OF 12` — the tally the tile is for.

   Both numbers are counted over the whole list before the rows are capped, so
   the header is about the list rather than about the six rows that fitted in
   the payload. Counting the delivered rows instead is what made this say
   `4 OF 6` about a list of twelve.
   */
  private func count(_ list: WidgetSnapshot.Checklist) -> String? {
    guard list.open > 0 else { return nil }
    return "\(list.open) OF \(list.total)"
  }

  /**
   The caption under the marks, when there is one.

   Three states and three sentences. A list that has been emptied is not one
   that has been finished, and saying "All done." over an empty list is the
   tile congratulating the user for nothing.
   */
  private func closingLine(_ list: WidgetSnapshot.Checklist) -> String? {
    if list.total == 0 { return "Nothing on this list yet." }
    guard list.open == 0 else { return nil }
    return "All \(RidikFormat.spelled(list.total)) done."
  }
}
