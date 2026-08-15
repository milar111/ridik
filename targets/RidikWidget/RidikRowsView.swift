import SwiftUI
import WidgetKit

/**
 The four list faces — agenda, tasks, habits and one checklist.

 One view rather than four, because they differ in almost nothing that matters:
 each is an eyebrow, a count, and up to seven rows of `lead · text · trail`.
 Written as separate files they would drift apart a font size at a time, and a
 home screen holding three of them at once is exactly where that shows.

 The Today widget is the exception and keeps its own view: it is a headline, not
 a list, and forcing it through this shape would cost both of them.
 */

/// Which of the day's lists a widget draws. One case per `Widget` in the bundle.
enum RidikSection {
  case agenda
  case tasks
  case habits
  case list
}

// MARK: - The face

struct RidikRowsView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var colorScheme

  let entry: RidikEntry
  let section: RidikSection

  var body: some View {
    let palette = RidikPalette.of(colorScheme)

    content(palette)
      .padding(legacyMargin)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .ridikGround(palette.ground)
      .widgetURL(destination)
  }

  /// Content margins are iOS 17; before that a widget pads itself or bleeds.
  private var legacyMargin: CGFloat {
    if #available(iOS 17.0, *) { return 0 }
    return 14
  }

  @ViewBuilder
  private func content(_ palette: RidikPalette) -> some View {
    switch entry.face {
    case .ready(let snapshot):
      Rows(
        header: section.header(snapshot),
        rows: section.rows(snapshot, now: entry.date),
        empty: section.empty,
        palette: palette,
        family: family
      )
    case .stale(let snapshot):
      StaleFace(publishedAt: snapshot.publishedDate, palette: palette, wide: wide)
    case .blank(let reason):
      BlankFace(reason: reason, palette: palette, wide: wide)
    }
  }

  private var wide: Bool { family != .systemSmall }

  /// The list widget opens the list it was showing, not the pane in general.
  private var destination: URL {
    if case .list = section, case .ready(let snapshot) = entry.face, let list = snapshot.list {
      return Route.list(named: list.name)
    }
    return section.route
  }
}

// MARK: - Rows

private struct Rows: View {
  let header: RidikHeader
  let rows: [RidikRow]
  let empty: String
  let palette: RidikPalette
  let family: WidgetFamily

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Eyebrow(text: header.eyebrow, palette: palette)
        Spacer(minLength: 0)
        if let count = header.count {
          Text(count)
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .foregroundStyle(header.alarming ? palette.danger : palette.tertiaryText)
            .lineLimit(1)
        }
      }
      .padding(.bottom, 6)

      if rows.isEmpty {
        Text(empty)
          .font(.system(size: wide ? 15 : 13, weight: .semibold, design: .rounded))
          .foregroundStyle(palette.secondaryText)
          .lineLimit(2)
      } else {
        VStack(alignment: .leading, spacing: rowGap) {
          ForEach(rows.prefix(capacity)) { row in
            RowLine(row: row, palette: palette, wide: wide, leadWidth: leadWidth)
          }
        }
      }

      Spacer(minLength: 0)
    }
  }

  private var wide: Bool { family != .systemSmall }

  /// Small and medium are the same height, so they hold the same number of rows.
  private var capacity: Int {
    switch family {
    case .systemLarge: return 7
    case .systemSmall: return 3
    default: return 4
    }
  }

  private var rowGap: CGFloat { family == .systemLarge ? 9 : 6 }

  /**
   The lead column is fixed so the rows line up.

   A monospaced 24-hour time is the same width on every row, but "9:40 AM" and
   "12:40 PM" are not, and left to themselves each row would indent its title
   differently. The width is picked from the device's own clock setting rather
   than measured, because a widget cannot measure before it draws.
   */
  private var leadWidth: CGFloat {
    let twelveHour = (DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .current) ?? "")
      .contains("a")
    if !rows.contains(where: \.lead.isTime) { return 14 }
    return twelveHour ? (wide ? 60 : 54) : (wide ? 42 : 38)
  }
}

private struct RowLine: View {
  let row: RidikRow
  let palette: RidikPalette
  let wide: Bool
  let leadWidth: CGFloat

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 7) {
      lead
        .font(.system(size: wide ? 12 : 11, weight: .medium, design: .monospaced))
        .foregroundStyle(row.alert ? palette.danger : palette.accent)
        .lineLimit(1)
        .minimumScaleFactor(0.75)
        .frame(width: leadWidth, alignment: .leading)

      Text(row.text)
        .font(.system(size: wide ? 13 : 12, weight: .medium, design: .rounded))
        .foregroundStyle(row.spent ? palette.tertiaryText : palette.text)
        // The strikethrough is what makes a ticked row read as *done* rather
        // than as merely quieter, which grey alone does not say.
        .strikethrough(row.spent, color: palette.tertiaryText)
        .lineLimit(1)

      if let trail = row.trail, wide {
        Spacer(minLength: 4)
        Text(trail)
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundStyle(palette.tertiaryText)
          .lineLimit(1)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(row.spoken)
  }

  @ViewBuilder
  private var lead: some View {
    switch row.lead {
    case .time(let date): Text(date, style: .time)
    case .text(let text): Text(text)
    }
  }
}

// MARK: - What a row is

struct RidikRow: Identifiable {
  enum Lead {
    /// Rendered by the system, so it follows the device's 12/24-hour setting.
    case time(Date)
    case text(String)

    var isTime: Bool {
      if case .time = self { return true }
      return false
    }
  }

  let id: String
  let lead: Lead
  let text: String
  let trail: String?
  /// Done, ticked off, behind you — drawn struck through and dimmed.
  var spent: Bool = false
  /// Overdue. The lead turns red, and red only means anything if it is rare.
  var alert: Bool = false
  /// What VoiceOver reads instead of "9 40 A M, Materials lab, Workshop 2".
  var spoken: String = ""
}

struct RidikHeader {
  let eyebrow: String
  let count: String?
  /// Draws the count in the danger colour — used only for a live overdue count.
  var alarming: Bool = false
}

// MARK: - Each section

extension RidikSection {
  var route: URL {
    switch self {
    case .agenda: return Route.calendar
    case .tasks: return Route.tasks
    case .habits: return Route.habits
    case .list: return Route.lists
    }
  }

  var empty: String {
    switch self {
    case .agenda: return "Nothing left today"
    case .tasks: return "Nothing due today"
    case .habits: return "No habits tracked yet"
    case .list: return "No lists yet"
    }
  }

  func header(_ snapshot: WidgetSnapshot) -> RidikHeader {
    switch self {
    case .agenda:
      let left = snapshot.agenda.count
      return RidikHeader(eyebrow: "TODAY", count: left > 0 ? "\(left) left" : nil)
    case .tasks:
      // Overdue outranks due: it is the number that should pull the eye, and
      // showing both would spend the whole header line on arithmetic.
      if snapshot.tasks.overdue > 0 {
        return RidikHeader(eyebrow: "TASKS", count: "\(snapshot.tasks.overdue) late", alarming: true)
      }
      let due = snapshot.tasks.dueToday
      return RidikHeader(eyebrow: "TASKS", count: due > 0 ? "\(due) due" : nil)
    case .habits:
      let habits = snapshot.habits
      return RidikHeader(
        eyebrow: "HABITS",
        count: habits.total > 0 ? "\(habits.done)/\(habits.total)" : nil
      )
    case .list:
      guard let list = snapshot.list else { return RidikHeader(eyebrow: "LISTS", count: nil) }
      return RidikHeader(
        eyebrow: list.name.uppercased(),
        count: list.open > 0 ? "\(list.open) open" : "done"
      )
    }
  }

  func rows(_ snapshot: WidgetSnapshot, now: Date) -> [RidikRow] {
    switch self {
    case .agenda: return snapshot.agenda.map { agendaRow($0, now: now) }
    case .tasks: return snapshot.tasks.rows.map(taskRow)
    case .habits: return snapshot.habits.rows.map(habitRow)
    case .list: return (snapshot.list?.rows ?? []).map(listRow)
    }
  }

  private func agendaRow(_ item: WidgetSnapshot.AgendaRow, now: Date) -> RidikRow {
    // Only the *ending* is dropped by the builder, so a thing already under way
    // is still on this list — and saying so is the point of the widget.
    let running = item.startDate <= now
    return RidikRow(
      id: item.id,
      lead: .time(item.startDate),
      text: item.title,
      trail: item.location?.nilIfEmpty ?? (item.kind == "class" ? "class" : nil),
      spent: false,
      alert: false,
      spoken: [
        running ? "Now" : nil,
        item.title,
        running ? nil : "at \(Self.spokenTime.string(from: item.startDate))",
        item.location?.nilIfEmpty,
      ]
      .compactMap { $0 }
      .joined(separator: ", ")
    )
  }

  private func taskRow(_ task: WidgetSnapshot.TaskRow) -> RidikRow {
    // An overdue task's own time is yesterday's, and printing it invites the
    // reader to work out how late it is. The word says it in one glance.
    let lead: RidikRow.Lead =
      task.overdue ? .text("late") : task.dueDate.map { RidikRow.Lead.time($0) } ?? .text("·")
    let when =
      task.overdue ? "overdue" : task.dueDate.map { "due \(Self.spokenTime.string(from: $0))" }
    return RidikRow(
      id: task.id,
      lead: lead,
      text: task.title,
      trail: nil,
      alert: task.overdue,
      spoken: [task.title, when].compactMap { $0 }.joined(separator: ", ")
    )
  }

  private func habitRow(_ habit: WidgetSnapshot.HabitRow) -> RidikRow {
    RidikRow(
      id: habit.id,
      lead: .text(habit.doneToday ? "✓" : "○"),
      text: habit.name,
      // A streak of one is just "today" and not yet worth the word.
      trail: habit.streak > 1 ? "\(habit.streak)d" : nil,
      spent: habit.doneToday,
      spoken: [
        habit.name,
        habit.doneToday ? "done" : "not yet",
        habit.streak > 1 ? "\(habit.streak) day streak" : nil,
      ]
      .compactMap { $0 }
      .joined(separator: ", ")
    )
  }

  private func listRow(_ item: WidgetSnapshot.ListRow) -> RidikRow {
    RidikRow(
      id: item.id,
      lead: .text(item.done ? "✓" : "○"),
      text: item.text,
      trail: nil,
      spent: item.done,
      spoken: "\(item.text), \(item.done ? "done" : "still open")"
    )
  }

  /// VoiceOver gets a spoken time; the visible one stays a live `Text` style.
  private static let spokenTime: DateFormatter = {
    let formatter = DateFormatter()
    formatter.timeStyle = .short
    formatter.dateStyle = .none
    return formatter
  }()
}

extension String {
  /// A location that arrived as "" would otherwise draw an empty trailing column.
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
