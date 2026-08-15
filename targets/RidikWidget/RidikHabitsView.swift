import SwiftUI
import WidgetKit

/**
 Habits — six rails, whether or not there are six habits (WIDGETS §3.3).

 Two decisions carry this face and both are easy to undo by accident.

 **The names live in a left gutter, never above the rail.** The cross-habit read
 — "everything dies on a Sunday" — is a vertical read down aligned columns, and
 a name line between rails destroys it.

 **All six slots are always drawn.** A board occupies its rectangle at zero
 habits; a list does not. The empty slots teach the capacity without a word, and
 they are why this tile is worth looking at before anything has been logged.

 The hot cell here is today's column rather than a single square. Six logged
 habits are six hot cells, which is what §3.3 asks for literally and stays well
 inside the reason for the rule: at 10×12 in a 305×131 tile that column is under
 two percent of the face.
 */
struct RidikHabitsView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var colorScheme

  let entry: RidikEntry

  var body: some View {
    let palette = RidikPalette.of(colorScheme)

    content(palette)
      .padding(legacyMargin)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .ridikGround(palette)
      .widgetURL(Route.habits)
  }

  /// Content margins are iOS 17; before that a widget pads itself or bleeds.
  private var legacyMargin: CGFloat {
    if #available(iOS 17.0, *) { return 0 }
    return 14
  }

  private var metrics: HabitsMetrics {
    switch family {
    case .systemSmall: return HabitsMetrics(window: 7, gutter: 50, cellHeight: 12, showsBest: false)
    case .systemLarge: return HabitsMetrics(window: 35, gutter: 70, cellHeight: 20, showsBest: true)
    default: return HabitsMetrics(window: 21, gutter: 56, cellHeight: 12, showsBest: false)
    }
  }

  @ViewBuilder
  private func content(_ palette: RidikPalette) -> some View {
    let metrics = self.metrics

    switch entry.face {
    case .ready(let snapshot):
      HabitsBoard(
        rails: rails(snapshot, window: metrics.window, marksToday: true),
        letters: letters(snapshot, window: metrics.window),
        trailing: snapshot.habits.total > 0
          ? "\(snapshot.habits.done)/\(snapshot.habits.total)" : nil,
        note: note(snapshot),
        palette: palette,
        metrics: metrics
      )
    case .stale(let snapshot):
      HabitsBoard(
        // The last column is not today on a stale face, and lighting it would
        // claim a habit had been logged on a day that has not started.
        rails: rails(snapshot, window: metrics.window, marksToday: false),
        letters: letters(snapshot, window: metrics.window),
        trailing: nil,
        note: (headline: "Yesterday's plan.", sub: "Open Ridik to bring today's in."),
        palette: palette,
        metrics: metrics
      )
    case .blank(let reason):
      HabitsBoard(
        rails: coldRails(window: metrics.window),
        letters: deviceLetters(window: metrics.window, at: entry.date),
        trailing: nil,
        note: (headline: reason.headline, sub: reason.detail),
        palette: palette,
        metrics: metrics
      )
    }
  }

  // MARK: What each rail draws

  private func rails(_ snapshot: WidgetSnapshot, window: Int, marksToday: Bool) -> [HabitRailRow] {
    let rows = snapshot.habits.rows
    return (0..<HabitsMetrics.slots).map { index -> HabitRailRow in
      guard index < rows.count else { return HabitRailRow.empty(index, window: window) }
      let habit = rows[index]
      return HabitRailRow(
        id: index,
        name: habit.name,
        // A streak of one is just "today" and not yet worth the word.
        streak: habit.streak > 1 ? "\(habit.streak)d" : nil,
        best: habit.longestStreak > 1 ? "best \(habit.longestStreak)" : nil,
        history: habit.window(window),
        marksToday: marksToday
      )
    }
  }

  private func coldRails(window: Int) -> [HabitRailRow] {
    (0..<HabitsMetrics.slots).map { HabitRailRow.empty($0, window: window) }
  }

  /// The weekday letters over the columns, ending on the day the payload describes.
  private func letters(_ snapshot: WidgetSnapshot, window: Int) -> [String] {
    letters(window: window, endingOn: snapshot.dayNoon, snapshot.calendar)
  }

  /// With nothing published there is no zone to trust but the device's own.
  private func deviceLetters(window: Int, at date: Date) -> [String] {
    letters(window: window, endingOn: date, RidikCalendar.device)
  }

  private func letters(window: Int, endingOn end: Date, _ calendar: Calendar) -> [String] {
    let symbols = calendar.veryShortWeekdaySymbols
    guard symbols.count == 7 else { return [] }
    return (0..<window).map { index in
      let date = calendar.date(byAdding: .day, value: index - (window - 1), to: end) ?? end
      return symbols[max(0, min(6, calendar.component(.weekday, from: date) - 1))]
    }
  }

  // MARK: What the face says

  private func note(_ snapshot: WidgetSnapshot) -> (headline: String, sub: String?)? {
    let habits = snapshot.habits
    if habits.total == 0 || !snapshot.configured.habits {
      return (
        "Six slots, all cold.",
        "Say \u{201C}I ran today\u{201D} and the first one lights."
      )
    }
    guard habits.done == habits.total else { return nil }
    let best = habits.rows.map(\.longestStreak).max() ?? 0
    return (
      "All \(RidikFormat.spelled(habits.total)), today.",
      // "1 days" is the sentence somebody sees on the very first day they ever
      // log a habit — the one day this line is most likely to be read.
      best > 0 ? "Longest run: \(best) \(best == 1 ? "day" : "days")." : nil
    )
  }
}

// MARK: - The board

struct HabitsMetrics {
  /// Days per rail: 7, 21 or 35, always the *last* N of the published history.
  let window: Int
  let gutter: CGFloat
  let cellHeight: CGFloat
  let showsBest: Bool

  /// Six, whether or not there are six habits. See the note on this file.
  static let slots = 6
  /// Between the gutter and the rail, and between the letters and their column.
  static let rail: CGFloat = 6
  static let cellGap: CGFloat = 1.4
}

struct HabitRailRow: Identifiable {
  let id: Int
  let name: String
  let streak: String?
  let best: String?
  let history: [Character]
  let marksToday: Bool

  /// A slot with no habit in it: a cold rail and an empty gutter.
  static func empty(_ id: Int, window: Int) -> HabitRailRow {
    HabitRailRow(
      id: id,
      name: "",
      streak: nil,
      best: nil,
      history: Array(repeating: "0", count: window),
      marksToday: false
    )
  }
}

private struct HabitsBoard: View {
  let rails: [HabitRailRow]
  let letters: [String]
  let trailing: String?
  let note: (headline: String, sub: String?)?
  let palette: RidikPalette
  let metrics: HabitsMetrics

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      TileHeader(eyebrow: "HABITS", trailing: trailing, palette: palette)

      lettersRow
        .padding(.top, 2)

      ForEach(rails) { rail in
        row(rail)
          // Every slot takes exactly its share of what is left, whatever is in
          // it. Without this the slots with a name in them would be measured
          // from their text and the empty ones would swallow the difference.
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }

      if let note {
        EmptyNote(headline: note.headline, sub: note.sub, palette: palette, compact: true)
          .padding(.top, 3)
      }
    }
  }

  private var lettersRow: some View {
    HStack(spacing: HabitsMetrics.rail) {
      Color.clear.frame(width: metrics.gutter, height: 1)
      HStack(spacing: HabitsMetrics.cellGap) {
        ForEach(letters.indices, id: \.self) { index in
          Text(letters[index])
            .font(.system(size: 9, weight: .regular, design: .monospaced))
            .foregroundStyle(palette.tertiaryText)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .frame(maxWidth: .infinity)
        }
      }
    }
  }

  private func row(_ rail: HabitRailRow) -> some View {
    HStack(spacing: HabitsMetrics.rail) {
      gutter(rail)
        .frame(width: metrics.gutter, alignment: .leading)

      HabitRail(history: rail.history, palette: palette, marksToday: rail.marksToday)
        .frame(maxHeight: metrics.cellHeight)
    }
  }

  @ViewBuilder
  private func gutter(_ rail: HabitRailRow) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline, spacing: 3) {
        Text(rail.name)
          .font(.system(size: 11, weight: .medium, design: .rounded))
          .foregroundStyle(palette.text)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
        Spacer(minLength: 2)
        if let streak = rail.streak {
          Text(streak)
            .font(.system(size: 9, weight: .medium, design: .monospaced))
            .foregroundStyle(palette.accent)
            .lineLimit(1)
        }
      }

      if metrics.showsBest, let best = rail.best {
        Text(best)
          .font(.system(size: 9, weight: .regular, design: .monospaced))
          .foregroundStyle(palette.tertiaryText)
          .lineLimit(1)
      }
    }
  }
}
