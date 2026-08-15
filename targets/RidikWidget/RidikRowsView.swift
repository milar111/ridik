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
    let palette = RidikPalette.of(colorScheme)

    content(palette)
      .padding(legacyMargin)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .ridikGround(palette)
      .widgetURL(Route.tasks)
  }

  /// Content margins are iOS 17; before that a widget pads itself or bleeds.
  private var legacyMargin: CGFloat {
    if #available(iOS 17.0, *) { return 0 }
    return 14
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
      VStack(alignment: .leading, spacing: 0) {
        TileHeader(eyebrow: "TASKS", palette: palette)
        strip([], palette: palette)
        Spacer(minLength: 4)
        EmptyNote(
          headline: reason.headline,
          sub: reason.detail,
          palette: palette,
          compact: small
        )
      }
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

      Spacer(minLength: 4)

      rowsOrNote(snapshot, palette: palette, stale: stale)
    }
  }

  private func header(_ tasks: WidgetSnapshot.Tasks) -> String? {
    if tasks.overdue > 0 { return "\(tasks.overdue) LATE" }
    if tasks.dueToday > 0 { return "\(tasks.dueToday) DUE" }
    return nil
  }

  private func strip(_ ages: [Int], palette: RidikPalette) -> some View {
    DebtStrip(
      ages: ages,
      cap: small ? 12 : 24,
      palette: palette,
      cellWidth: small ? 8 : 10
    )
    .frame(height: small ? 16 : 18)
    .padding(.top, 6)
  }

  private func footer(_ tasks: WidgetSnapshot.Tasks, palette: RidikPalette) -> some View {
    HStack(spacing: 6) {
      if let oldest = tasks.ages.first, oldest > 0 {
        Text("oldest \(oldest)d")
      }
      Spacer(minLength: 4)
      Text("\(tasks.open) open")
    }
    .font(.system(size: small ? 11 : 12, weight: .medium, design: .rounded))
    .foregroundStyle(palette.secondaryText)
    .lineLimit(1)
    .padding(.top, 4)
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
      VStack(alignment: .leading, spacing: 6) {
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
    let palette = RidikPalette.of(colorScheme)

    content(palette)
      .padding(legacyMargin)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .ridikGround(palette)
      .widgetURL(destination)
  }

  /// Content margins are iOS 17; before that a widget pads itself or bleeds.
  private var legacyMargin: CGFloat {
    if #available(iOS 17.0, *) { return 0 }
    return 14
  }

  private var small: Bool { family == .systemSmall }

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
        blank(
          headline: "No list yet.",
          sub: "Say \u{201C}add bolts to the hardware list\u{201D}.",
          palette: palette
        )
      }
    case .blank(let reason):
      blank(headline: reason.headline, sub: reason.detail, palette: palette)
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

    VStack(alignment: .leading, spacing: 0) {
      TileHeader(
        eyebrow: list.name.uppercased(),
        trailing: count(list),
        palette: palette
      )

      // A list with nothing on it yet is not the same as one you have finished,
      // and neither of them is a reason to draw no graphic at all. The marks
      // are this tile's only drawing; leaving them out is what would make it
      // the one face in the family that is a bare sentence on a rectangle.
      VStack(alignment: .leading, spacing: 7) {
        if rows.isEmpty {
          ForEach(0..<capacity(done: true), id: \.self) { _ in
            RowMark(done: false, palette: palette)
          }
        } else {
          ForEach(Array(rows.prefix(capacity(done: done)))) { row in
            RowLine(
              row: row,
              palette: palette,
              wide: !small,
              leadWidth: ridikLeadWidth(for: rows, wide: !small)
            )
          }
        }
      }
      .padding(.top, 6)

      Spacer(minLength: 4)

      if let closing = closingLine(list) {
        // Under the drawing, as §4 requires — the sentence is a caption on the
        // marks, not a replacement for them.
        EmptyNote(headline: closing, palette: palette, compact: small)
      }
    }
  }

  /**
   Still a drawing, even here.

   Four cold marks in a column: the tile keeps its shape, and the one graphic
   this face has is the one it shows when there is nothing to tick.
   */
  private func blank(headline: String, sub: String?, palette: RidikPalette) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      TileHeader(eyebrow: "LIST", palette: palette)

      VStack(alignment: .leading, spacing: 7) {
        ForEach(0..<4, id: \.self) { _ in
          RowMark(done: false, palette: palette)
        }
      }
      .padding(.top, 8)

      Spacer(minLength: 6)

      EmptyNote(headline: headline, sub: sub, palette: palette, compact: small)
    }
  }

  private func capacity(done: Bool) -> Int {
    let rows = small ? 4 : 5
    // The sentence costs a row when it is there.
    return done ? rows - 1 : rows
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
