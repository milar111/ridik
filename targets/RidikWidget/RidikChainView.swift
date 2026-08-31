import SwiftUI
import WidgetKit

/**
 The week — seven cells, Monday first, with today ringed.

 The family's cheapest face and one of its most useful, because it is the only
 tile that answers a question about *tomorrow*. Today draws the day you are
 standing in; Calendar draws a month you have to find the row in. Neither says
 "Thursday is the bad one" at a glance, and that is the single thing anybody
 actually looks at a week for.

 ## The week is its own payload field, not seven characters of the month plate

 `month.load` covers the current month and nothing else, so a week straddling
 the 1st is half in a plate that has no cells for it. Slicing would draw those
 days `cold` — and cold is how this face says *free*, so the tile would report a
 clear Monday over a Monday with four things on it. `buildWeek` in `snapshot.ts`
 publishes the seven days directly, using the same overlap arithmetic as the
 plate so the two faces can never disagree about a day they both draw.

 ## Staleness is not asked, deliberately

 `todayIndex` is `-1` when the payload is not this week's, so no cell is ringed
 and the face simply stops claiming a today. That is the honest degradation and
 it is different from the agenda's: the *shape* of a week published yesterday is
 still the shape of this week, where an agenda published yesterday may be a list
 of things that are already over.

 ## No large, by decision

 §2 rule 1 — extra height buys more cells before it buys air, and there is no
 eighth day to buy. A large tile would be these seven things drawn taller, which
 is the definition of the air the rule exists to forbid.
 */
struct RidikChainView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var colorScheme

  let entry: RidikEntry

  private var small: Bool { family == .systemSmall }

  var body: some View {
    let palette = RidikPalette.of(scheme: colorScheme, ember: entry.face.ember)

    content(palette)
      .ridikTilePadding()
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .ridikGround(palette)
      .widgetURL(Route.calendar)
  }

  @ViewBuilder
  private func content(_ palette: RidikPalette) -> some View {
    switch entry.face {
    case .ready(let snapshot), .stale(let snapshot):
      face(snapshot, palette: palette)
    case .blank(let reason):
      NoticePane(reason: reason, palette: palette, compact: small)
    }
  }

  @ViewBuilder
  private func face(_ snapshot: WidgetSnapshot, palette: RidikPalette) -> some View {
    let week = snapshot.week
    let cells = week.cells
    let clear = cells.filter { $0 == "0" }.count

    VStack(alignment: .leading, spacing: 0) {
      TileHeader(
        // "WEEK" on a small tile. 130 points has to carry the eyebrow, the
        // count and the gap between them, and "THIS WEEK" truncated to
        // "THIS W…" — an ellipsis is a promise that something was left out,
        // and here the thing left out was the word that mattered.
        eyebrow: small ? "WEEK" : "THIS WEEK",
        trailing: clear == 0 ? "FULL" : "\(clear) CLEAR",
        emphasis: true,
        palette: palette
      )

      HStack(alignment: .top, spacing: 4) {
        ForEach(0..<7, id: \.self) { index in
          Day(
            index: index,
            date: Self.date(week.startDate, plus: index),
            level: cells[index],
            today: index == week.todayIndex,
            // A day is a *column* here, not a chip: seven cells in a band across
            // the top of a two-row tile with nothing under them is the same
            // cheap drawing the rest of this family was making. `CHAIN_HEIGHT`
            // in the Android plugin is the other end of these.
            //
            // **68, not 96, and the 96 was never drawable.** A column is a
            // 9-point letter, three of gap, the bar, three more and a 10-point
            // date: at 96 that is a 125-point cell under a 17-point header with
            // ten of padding, which is 152 of the 130 a medium tile has. It
            // clipped in silence, and what it clipped was the date row — the
            // face lost the numbers off the bottom and nothing said so.
            //
            // The clear-week case takes less again, because the sentence below
            // needs the room and seven identical cold columns are the one case
            // where the height of a bar carries nothing to lose.
            height: small ? (clear == 7 ? 32 : 44) : (clear == 7 ? 40 : 68),
            palette: palette
          )
        }
      }
      .padding(.top, 10)

      Spacer(minLength: 2)

      if clear == 7 {
        EmptyNote(
          headline: "A clear week.",
          sub: "Nothing on any of the seven days.",
          palette: palette,
          compact: small
        )
      }
    }
  }

  /**
   The day-of-month for one cell, or nil when the payload carries no week.

   Nil rather than falling back to the device's own calendar: a date strip
   invented in this process would be seven numbers that agree with nothing on
   the tile, which is worse than seven blanks.
   */
  static func date(_ startDate: String, plus days: Int) -> Int? {
    let parts = startDate.split(separator: "-")
    guard parts.count == 3,
          let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2])
    else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    // UTC throughout: this is date arithmetic on a date the payload already
    // resolved in the user's own zone, so re-interpreting it in another one can
    // only move it. Nothing here is a moment.
    calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
    guard let start = calendar.date(from: DateComponents(year: year, month: month, day: day)),
          let shifted = calendar.date(byAdding: .day, value: days, to: start)
    else { return nil }
    return calendar.component(.day, from: shifted)
  }
}

/// One day: its letter, its cell, and its date.
private struct Day: View {
  /// 0-6 from Monday. Both the glyph and the spoken name come from it: the
  /// letters are ambiguous by design — two Ts and two Ss — so a spoken form
  /// derived from the glyph could not tell Tuesday from Thursday.
  let index: Int
  let date: Int?
  let level: Character
  let today: Bool
  let height: CGFloat
  let palette: RidikPalette

  var body: some View {
    VStack(spacing: 3) {
      Text(Self.letters[index])
        .font(.system(size: 9, weight: .medium))
        .foregroundStyle(palette.secondaryText)
        .lineLimit(1)

      HeatCell(level: level, palette: palette)
        .frame(height: height)
        .overlay {
          // The same ring the month plate gives today, drawn whether or not the
          // cell is also filled hot — §3.2 literally, and what Android draws,
          // where the ringed drawable is picked from the day and never from
          // whether it is the tile's hot object.
          if today {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
              .strokeBorder(palette.rim ?? palette.accent, lineWidth: 1)
          }
        }

      Text(date.map(String.init) ?? "")
        .font(.system(size: 10, weight: today ? .bold : .regular, design: .monospaced))
        .foregroundStyle(today ? palette.accent : palette.secondaryText)
        .lineLimit(1)
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(spoken)
  }

  private var spoken: String {
    let load: String
    switch level {
    case "1": load = "light"
    case "2": load = "busy"
    case "3": load = "full"
    default: load = "clear"
    }
    let stamp = date.map { " the \($0)" } ?? ""
    return today ? "Today, \(name)\(stamp), \(load)" : "\(name)\(stamp), \(load)"
  }

  /**
   Monday first, and stated rather than taken from the locale.

   `buildWeek` starts every week on a Monday whatever the device's own first day
   of the week is, so these seven letters are a constant of the payload. A locale
   lookup here would relabel the cells without moving them.
   */
  private static let letters = ["M", "T", "W", "T", "F", "S", "S"]

  private static let names = [
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  ]

  private var name: String { Self.names[min(max(index, 0), 6)] }
}
