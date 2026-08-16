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
    let palette = RidikPalette.of(scheme: colorScheme, ember: entry.face.ember)

    content(palette)
      .ridikTilePadding()
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .ridikGround(palette)
      .widgetURL(Route.habits)
  }

  @ViewBuilder
  private func content(_ palette: RidikPalette) -> some View {
    if case .blank(let reason) = entry.face {
      // Nothing published, or a payload this build cannot read. The only two
      // states in the family that take the whole tile — WIDGETS §4.
      NoticePane(reason: reason, palette: palette, compact: family == .systemSmall)
    } else {
      // **The board is sized by its width and by nothing else.**
      //
      // The family it was handed says nothing useful here: a `.systemLarge`
      // tile is *tall*, not wide, and picking the five-week window from it put
      // thirty-five columns into the same 305 points that hold twenty-one — a
      // 6pt column beside a gutter of ellipsised names, which is the tile the
      // client photographed. Habits gains columns with width and only air with
      // height, so it is bucketed on width alone, exactly as `railSizeOf` now
      // does on Android (WIDGETS §2, rule 3).
      GeometryReader { proxy in
        let metrics = HabitsMetrics.of(width: proxy.size.width)
        board(metrics, palette: palette)
          .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
      }
    }
  }

  @ViewBuilder
  private func board(_ metrics: HabitsMetrics, palette: RidikPalette) -> some View {
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
    case .blank:
      // Handled above, before there is any geometry to read.
      EmptyView()
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

  /// The weekday letters over the columns, ending on the day the payload describes.
  private func letters(_ snapshot: WidgetSnapshot, window: Int) -> [String] {
    letters(window: window, endingOn: snapshot.dayNoon, snapshot.calendar)
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

/**
 What the board draws at the width it was given.

 Every field here is a function of one number, and that is the point. The four
 sizing rules in WIDGETS §2 all say the same thing in different words — the tile
 does not get to stretch what is in it — and on this face they all come down to
 how many columns fit beside a gutter that can hold a real word.
 */
struct HabitsMetrics {
  /// Days per rail: 7, 21 or 35, always the *last* N of the published history.
  let window: Int
  /// The names' column. Never sized from the text; the text is sized to fit it.
  let gutter: CGFloat
  /**
   How tall a bar is allowed to get.

   A cap, not a height. The rails still share the tile's height between them —
   that is what makes the board fill its rectangle — and the slack shows as
   space *between* rails rather than as a chart whose thickness means nothing.
   The same numbers as Android's `RAIL_HEIGHT`.
   */
  let cellHeight: CGFloat
  let showsBest: Bool
  let showsStreak: Bool
  /// What one day of history actually gets, gap included. The ruler lives on this.
  let column: CGFloat

  /// Six, whether or not there are six habits. See the note on this file.
  static let slots = 6
  /// Between the gutter and the rail, and between the letters and their column.
  static let rail: CGFloat = 6
  /**
   Between one day's bar and the next.

   Two, not 1.4. At 1.4 a lit run of a fortnight fused into one long block and
   the board stopped being a count of days — which is the whole reading. The
   bars lose about half a point each and the field gains its grain back.
   */
  static let cellGap: CGFloat = 2

  /**
   Ground between one rail and the next, and it is not optional.

   The rails share the tile's height, and the bar is only *capped* at
   `cellHeight` — so on a short tile carrying a sentence as well the row and the
   bar are the same height, and six rails with nothing between them fuse into
   twenty-one full-height columns. The empty board is where that shows, which is
   the one state this face is judged on. Android reserves the same points as
   `layout_marginTop` on every rail row.

   Three now rather than two: the rails sit in a well, so what shows between
   them is the floor of the recess, and two points of it read as a printing
   error rather than as ground.
   */
  static let railGap: CGFloat = 3

  /**
   Below this a 9pt weekday letter does not fit in its column.

   The ruler is *dropped* below it rather than shrunk into it: 35 columns in 305
   points is about 6pt each, and the letters were reaching that by way of
   `minimumScaleFactor(0.6)` — a 5pt glyph, which is a grey smudge over every
   column and not a label. Android drops the ruler on its large board for the
   same arithmetic and says so in `rails`.
   */
  static let rulerFloor: CGFloat = 8

  var showsRuler: Bool { column >= Self.rulerFloor }

  /**
   The board, bucketed on width alone — the twin of `railSizeOf` in `RidikCells.kt`.

   The thresholds are Android's, less the 12pt of padding each side that its
   numbers are quoted on the outside of: 260dp and 360dp of tile are 236 and 336
   of content. A `.systemMedium` and a `.systemLarge` iPhone tile are both 305
   points wide, so they draw the same twenty-one columns and differ only in how
   much air is under them — which is the correct answer to a tile that got
   taller rather than wider.

   The gutter is the width the *names* need, capped at a share of the tile.
   Android can quote it in flat dp because its narrowest tile is still 140dp
   wide; a `.systemSmall` here is 131 points *in total*, and an 84pt gutter on
   that leaves seven columns 5.9 points each. So it is the smaller of the two,
   and what gives way as the tile narrows is the streak, then the best — a
   number you can live without, before a name you cannot.
   */
  static func of(width: CGFloat) -> HabitsMetrics {
    let window: Int
    let ideal: CGFloat
    let height: CGFloat
    // A point off each: six rails, a header whose fraction is now a readout
    // rather than an engraving, and a recess around the board all have to come
    // out of the same 131 points, and the bar is the one thing here that can
    // give a point without losing a reading.
    switch width {
    case ..<236: (window, ideal, height) = (7, 84, 15)
    case ..<336: (window, ideal, height) = (21, 94, 14)
    default: (window, ideal, height) = (35, 118, 13)
    }

    // Never more than this share of the tile, whatever the names want. The
    // gutter that ate a third of the board is the other half of the complaint
    // the wide one fixed.
    let gutter = max(44, min(ideal, width * 0.42))
    let rails = max(1, width - gutter - rail - CellWell.inset * 2)

    return HabitsMetrics(
      window: window,
      gutter: gutter,
      cellHeight: height,
      // `best` is a second line under the name and costs height, not width —
      // but it is only ever asked for on the five-week board, which is the one
      // wide enough to hold three columns of gutter. Android draws it in the
      // same place for the same reason.
      showsBest: window == 35,
      // A streak beside a name needs about 26 points that a 131pt tile does not
      // have. Dropped there, kept everywhere else.
      showsStreak: gutter >= 66,
      column: rails / CGFloat(window)
    )
  }
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
      // `4/6` is the only number this face has and it is the reading, so it is
      // set as one. At 10pt tracked it was a label on a board, which left the
      // tile with nothing the eye lands on first.
      TileHeader(eyebrow: "HABITS", trailing: trailing, emphasis: true, palette: palette)

      // Dropped whole when the columns are too narrow to letter, rather than
      // set in 5pt type over them. The rails keep the height it would have had.
      if metrics.showsRuler {
        lettersRow
          .padding(.top, 3)
      }

      // **One well behind all six rails, not one per rail.** Six troughs would
      // cost three points each — eighteen out of the 131 a medium tile has —
      // and buy an outline around every bar. One recess costs six, reads as the
      // board being sunk into the tile, and turns `railGap` into visible floor
      // between the rails rather than plain ground.
      VStack(spacing: HabitsMetrics.railGap) {
        ForEach(rails) { rail in
          row(rail)
            // Every slot takes exactly its share of what is left, whatever is in
            // it. Without this the slots with a name in them would be measured
            // from their text and the empty ones would swallow the difference.
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .inWell(palette, radius: 6)
      .padding(.top, 4)

      if let note {
        EmptyNote(headline: note.headline, sub: note.sub, palette: palette, compact: true)
          .padding(.top, 4)
          // The sentence is measured before the board, not after it. Six rails
          // that each want their full bar height add up to more than a short
          // tile has, and a `VStack` hands the overflow to whatever is last —
          // so "Six slots, all cold." was drawn off the bottom edge of the one
          // tile it exists to explain. The rails shrink; the words do not.
          .layoutPriority(1)
      }
    }
  }

  /**
   The weekday letters, padded by the well's own inset.

   The rails start `CellWell.inset` in from the tile's edge now, so the ruler
   has to as well — the same agreement `DayAxis` keeps with `DayElement`, and
   the same silent failure if it is broken: every letter sitting three points
   left of the column it names.
   */
  private var lettersRow: some View {
    HStack(spacing: HabitsMetrics.rail) {
      Color.clear.frame(width: metrics.gutter, height: 1)
      HStack(spacing: HabitsMetrics.cellGap) {
        ForEach(letters.indices, id: \.self) { index in
          // No `minimumScaleFactor`: a letter that does not fit is a ruler that
          // should not be there, and shrinking it is how 35 columns got a 5pt
          // alphabet. `showsRuler` has already made that call.
          Text(letters[index])
            .font(.system(size: 9, weight: .regular, design: .monospaced))
            .foregroundStyle(palette.tertiaryText)
            .lineLimit(1)
            .frame(maxWidth: .infinity)
        }
      }
    }
    .padding(.horizontal, CellWell.inset)
  }

  /**
   The rail, with its name laid *over* the gutter rather than beside it.

   An `HStack` would put the name in the row's layout, and a `Text` is never
   shorter than one line — so six rails carried a 13pt floor each whether or not
   there was a habit in them, the board demanded 88 points it did not always
   have, and a `VStack` gave the overflow to the last thing in it: the sentence
   under the board, drawn off the bottom edge of the tile. Six slots, all cold,
   and no way to read the words saying so.

   As an overlay the row's own minimum is the rail's, which is nothing — the
   same thing Android gets from `layout_height="0dp"` with a weight, where the
   name is simply clipped in a squeezed row. The gutter is centred in whatever
   height the row ends up with and may spill a point past it, which at these
   sizes is invisible and is the correct thing to spend before the copy.
   */
  private func row(_ rail: HabitRailRow) -> some View {
    HabitRail(
      history: rail.history,
      palette: palette,
      marksToday: rail.marksToday,
      gap: HabitsMetrics.cellGap
    )
    .frame(maxHeight: metrics.cellHeight)
    .padding(.leading, metrics.gutter + HabitsMetrics.rail)
    .overlay(alignment: .leading) {
      gutter(rail)
        .frame(width: metrics.gutter, alignment: .leading)
    }
  }

  @ViewBuilder
  private func gutter(_ rail: HabitRailRow) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline, spacing: 3) {
        // The one thing on this face that never gives way. The gutter is sized
        // to hold a real habit name; the columns narrow instead, and the streak
        // beside it goes before the name does.
        Text(rail.name)
          .font(.system(size: 11, weight: .medium, design: .rounded))
          .foregroundStyle(palette.text)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
        Spacer(minLength: 2)
        if metrics.showsStreak, let streak = rail.streak {
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
