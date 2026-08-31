import SwiftUI
import WidgetKit

/**
 The completion rings — the one face in the family that draws a proportion.

 §1 bans progress rings across the family, and this face does not vacate that
 ban; it narrows it, and the narrowing is written into §1 rather than left
 implicit here. The argument for a tile is genuinely weaker than for the app
 screen this pattern came from: a ring read from across a room is a smear where
 four discrete levels are not. So it exists as a face the user *chooses*, never
 as a replacement for the Habits rails beside it, and the two are never the same
 tile.

 Where Android has to raster the arc — `RemoteViews` cannot draw one, see
 `RidikRings.kt` — SwiftUI trims a `Circle` and is done. The numbers the two draw
 are the same numbers: the share of the payload's history string that is kept,
 floored, with 100 reserved for a genuinely unbroken record.

 Habit order is the payload's order and is never sorted here. A rail is read down
 its columns, and re-sorting by how well each habit is going would reshuffle the
 board every time anything is logged — so the rings inherit the rule, and a ring
 and a rail describe the same habit in the same position.
 */
struct RidikRingsView: View {
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

  /**
   Six, in two rows of three — and the ring's name sits *beside* it, not under.

   The under-label version of this face did not fit and never had. A medium
   tile's content box is 312 x 130; a 56-point ring with four points of gap and
   an eleven-point name under it is a 73-point row, so two rows plus the header
   asked for about 189 points of the 130 there are. WidgetKit does not complain,
   it clips — so the face shipped with its header cut off the top and the second
   row's names cut off the bottom, which is exactly how it was found.

   Height is the scarce axis on a medium tile and width is the abundant one: 312
   points across three columns is 97 each, and a name reads perfectly well in the
   49 of those the ring does not want. So the label moved sideways, which buys
   the whole row back — 42 points instead of 73 — and every one of the six
   habits still shows, which is the thing this face exists to do.
   */
  private var slots: Int { family == .systemSmall ? 2 : 6 }

  /// Three to a row, so six is two rows and a smaller set is one.
  private var perRow: Int { min(slots, 3) }

  @ViewBuilder
  private func content(_ palette: RidikPalette) -> some View {
    switch entry.face {
    // Deliberately no staleness branch, exactly as the Habits face has none: a
    // five-week record is as true today as it was when it was published, and a
    // "yesterday's plan" notice over it would be a claim about the wrong thing.
    case .ready(let snapshot), .stale(let snapshot):
      if snapshot.habits.rows.isEmpty || !snapshot.configured.habits {
        empty(palette)
      } else {
        face(snapshot, palette: palette)
      }
    case .blank(let reason):
      NoticePane(reason: reason, palette: palette, compact: family == .systemSmall)
    }
  }

  @ViewBuilder
  private func face(_ snapshot: WidgetSnapshot, palette: RidikPalette) -> some View {
    let rows = Array(snapshot.habits.rows.prefix(slots))

    VStack(alignment: .leading, spacing: 0) {
      TileHeader(
        eyebrow: "HABITS",
        trailing: "\(snapshot.habits.done)/\(snapshot.habits.total)",
        emphasis: true,
        palette: palette
      )

      // 10 and 10, measured rather than chosen: the header is 17, two 42-point
      // rows and the gap between them are 94, and 17 + 10 + 94 is 121 of the 130
      // a medium tile has. The nine points left over are what stops a user's
      // larger type size clipping the thing again.
      VStack(spacing: 10) {
        ForEach(Array(stride(from: 0, to: slots, by: perRow)), id: \.self) { start in
          HStack(alignment: .center, spacing: 10) {
            ForEach(start..<min(start + perRow, slots), id: \.self) { index in
              let row = rows.indices.contains(index) ? rows[index] : nil
              // Drawn cold rather than dropped: the empty slots teach the
              // capacity without a word, exactly as the rails' six do.
              Ring(name: row?.name ?? "", history: row?.history ?? "", palette: palette)
            }
          }
        }
      }
      .padding(.top, 10)
      .frame(maxHeight: .infinity, alignment: .top)
    }
  }

  /**
   Still a drawing: cold rings at the capacity a populated tile would show.

   One row, where the populated face draws two. The note underneath is two lines
   of copy and needs a row's worth of height to sit in, and a tile that clipped
   its own "No habits yet" while demonstrating six empty rings would be teaching
   the capacity at the cost of the sentence that explains it.
   */
  private func empty(_ palette: RidikPalette) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      TileHeader(eyebrow: "HABITS", palette: palette)

      HStack(alignment: .center, spacing: 10) {
        ForEach(0..<perRow, id: \.self) { _ in
          Ring(name: "", history: "", palette: palette)
        }
      }
      .padding(.top, 10)

      Spacer(minLength: 6)

      EmptyNote(
        headline: "No habits yet.",
        sub: "Say \u{201C}add gym to my habits\u{201D}.",
        palette: palette,
        compact: family == .systemSmall
      )
    }
  }
}

/**
 One ring, its percentage, and the habit's name beside it.

 The number sits *inside* the ring, which is the whole point of the shape: the
 ring is the reading and the digits are the same reading said precisely, in one
 glance rather than two. That part is unchanged.

 What moved is the **name**, from under the ring to the right of it, and the
 reason is arithmetic rather than taste — see `slots`. A label under the ring
 costs 17 points of the scarcest axis on the tile and the face could not pay it;
 to the right it costs nothing, because three columns of a 312-point box leave 49
 points spare next to a 42-point ring. `RING_DP` in the Android plugin and
 `RidikRings.kt` carry the same two numbers.
 */
private struct Ring: View {
  let name: String
  let history: String
  let palette: RidikPalette

  /// Matches Android's `STROKE_RATIO` — 4.5 points on a 42-point ring.
  private static let stroke: CGFloat = 4.5

  /// Matches `RING_DP` in the Android plugin.
  private static let diameter: CGFloat = 42

  var body: some View {
    HStack(spacing: 6) {
      ZStack {
        Circle()
          .stroke(palette.heatMid.opacity(0.24), lineWidth: Self.stroke)

        if swept > 0 {
          Circle()
            .trim(from: 0, to: swept)
            .stroke(
              palette.accent,
              style: StrokeStyle(lineWidth: Self.stroke, lineCap: .round)
            )
            // Twelve o'clock, clockwise — where every progress ring begins.
            .rotationEffect(.degrees(-90))
        }

        // 12pt inside a 42-point ring leaves 33 points of clear middle, and
        // "100%" sets in 30 of them. `minimumScaleFactor` is the guard for a
        // user who has scaled their type up, not the normal case.
        Text(RidikRings.label(history))
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(history.isEmpty ? palette.secondaryText : palette.text)
          .lineLimit(1)
          .minimumScaleFactor(0.75)
      }
      .frame(width: Self.diameter, height: Self.diameter)

      // Two lines, because the column is 49 points wide and a habit called
      // "Morning pages" is not unusual. It wraps rather than shrinking to
      // illegibility, and truncates only past that.
      Text(name)
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(palette.secondaryText)
        .lineLimit(2)
        .minimumScaleFactor(0.85)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(spoken)
  }

  /// Clamped rather than trusted: a sweep past 1 laps and draws a *shorter* arc.
  private var swept: CGFloat {
    CGFloat(min(max(RidikRings.rate(history), 0), 1))
  }

  private var spoken: String {
    guard !history.isEmpty else { return "No habit" }
    return "\(name), \(RidikRings.label(history)) of the last \(history.count) days"
  }
}

/**
 The arithmetic, kept in one place and matching `RidikRings.kt` line for line.

 Two platforms drawing the same record must not disagree about what it says, and
 the rounding rule is the part that is easy to get subtly different.
 */
enum RidikRings {
  static func rate(_ history: String) -> Double {
    guard !history.isEmpty else { return 0 }
    let kept = history.filter { $0 == "1" }.count
    return Double(kept) / Double(history.count)
  }

  /// Floored, and 100% reserved for a record with nothing missed.
  static func label(_ history: String) -> String {
    guard !history.isEmpty else { return "—" }
    let kept = history.filter { $0 == "1" }.count
    if kept >= history.count { return "100%" }
    return "\((kept * 100) / history.count)%"
  }
}
