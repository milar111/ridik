import SwiftUI
import WidgetKit

/**
 The Lock Screen set — the surface a phone shows more often than either of the
 other two.

 `WIDGETS.md` covers the home screen and §7b covers Control Center and Quick
 Settings. Between them sits the Lock Screen, and this is the one thing in the
 family that ships to **one platform only**. §7b has been amended to say so in
 as many words: the both-platforms rule is about *controls*, not about every
 surface. The failure it guards against is a capability existing on one platform
 and being invisible on the other — and a Lock Screen widget is not invisible on
 Android, it is *absent*, the way widgets themselves were until a year ago. The
 nearest Android equivalent is a notification, which is a different product
 decision and not this one.

 ## Monochrome is not a palette problem, it is a clarifying test

 The accessory families are monochrome by system decree: the renderer flattens
 everything to white at the alpha you give it, and on some Lock Screen tints it
 will vibrancy-blend that further. So the ember does not reach this file at all,
 and the four heat levels become four opacities — 22 / 45 / 70 / 100%.

 That is either a loss or a proof that the encoding was never about hue. It is
 the second: every face in the family encodes *how much* by how filled a cell is,
 and hue was only ever the family's signature. Nothing here needed rethinking to
 lose it, which is the argument.

 ## What each family can honestly carry

 - `accessoryInline` — one line above the clock, about thirty characters, and no
   graphic is possible at all. It is the only thing in the family that is *words
   only*, and it says the one sentence a lock screen has room for.
 - `accessoryCircular` — the next time, the day in six buckets under it, and the
   overdue count. Deliberately **not a ring**: the obvious circular gauge is the
   exact shape §1 bans, and the ban does not stop applying because the system
   handed you a circle.
 - `accessoryRectangular` — the eyebrow, the full strip, and the next thing.
   Burn-down survives intact; it is the only place the whole day fits.
 */
struct RidikLockView: View {
  @Environment(\.widgetFamily) private var family

  let entry: RidikEntry

  var body: some View {
    switch family {
    case .accessoryInline:
      InlineFace(entry: entry)
    case .accessoryCircular:
      CircularFace(entry: entry)
    default:
      RectangularFace(entry: entry)
    }
  }
}

/**
 One line above the clock, and no graphic is possible.

 `accessoryInline` renders as a single `Text` with an optional leading image and
 truncates hard at about thirty characters, so everything is spent on the answer:
 the time and what it is. No eyebrow, no counts — a line that says "TODAY · 2
 LATE · 15:00 · Materia…" has spent its width on labels.
 */
private struct InlineFace: View {
  let entry: RidikEntry

  var body: some View {
    switch entry.face {
    case .ready(let snapshot), .stale(let snapshot):
      if snapshot.isToday(entry.date), let next = snapshot.next {
        Text("\(RidikFormat.clockTime(next.startDate, snapshot.timeZone))  \(next.title)")
      } else {
        // Never blank. An inline widget that renders nothing looks like a
        // failed one, and "nothing scheduled" is a real answer to the question
        // the line is asking.
        Text("Nothing scheduled")
      }
    case .blank:
      Text("Open Ridik")
    }
  }
}

/**
 ≈72 × 72: the next time, the day in six buckets, the overdue count.

 **Not a ring.** `Gauge(_:value:)` in `.accessoryCircularCapacity` is right there
 and is the exact shape §1 bans; the ban does not lapse because the system handed
 you a circle. What goes in the circle is six cells of the same primitive as
 every other face — the day compressed to six buckets, which is as many as 72
 points holds and still lets a filled one be told from an empty one.
 */
private struct CircularFace: View {
  let entry: RidikEntry

  /// Six, and no more: below about 9 points a cell stops reading as filled or
  /// unfilled at a glance, which is the only thing it is there to say.
  private static let buckets = 6

  var body: some View {
    ZStack {
      AccessoryWidgetBackground()
      content
    }
    .ridikAccessoryContainer()
  }

  @ViewBuilder
  private var content: some View {
    switch entry.face {
    case .ready(let snapshot), .stale(let snapshot):
      let fresh = snapshot.isToday(entry.date)
      let nowCell = fresh ? snapshot.cellIndex(at: entry.date) : snapshot.day.cells.count

      VStack(spacing: 2) {
        Text(fresh ? (snapshot.next.map { RidikFormat.clockTime($0.startDate, snapshot.timeZone) } ?? "—") : "—")
          .font(.system(size: 15, weight: .semibold, design: .monospaced))
          .lineLimit(1)
          .minimumScaleFactor(0.7)

        HStack(spacing: 1.5) {
          ForEach(0..<Self.buckets, id: \.self) { bucket in
            let slice = Self.bucket(bucket, of: snapshot.day.cells)
            RoundedRectangle(cornerRadius: 1, style: .continuous)
              .fill(.white.opacity(Self.opacity(slice.level)))
              .frame(height: slice.last <= nowCell ? 4 : 7)
          }
        }
        .frame(height: 7, alignment: .bottom)

        if snapshot.tasks.overdue > 0 {
          Text("\(snapshot.tasks.overdue) late")
            .font(.system(size: 9, weight: .medium))
            .lineLimit(1)
        }
      }
      .padding(.horizontal, 8)
    case .blank:
      Image(systemName: "mic.fill").font(.system(size: 18))
    }
  }

  /// The busiest cell in one sixth of the day, and the last cell it covers.
  ///
  /// The *maximum* rather than the mean, deliberately: a bucket holding one full
  /// hour and two empty ones is an hour you cannot move, and averaging it to
  /// `low` would report a free afternoon.
  static func bucket(_ index: Int, of cells: [Character]) -> (level: Character, last: Int) {
    guard !cells.isEmpty else { return ("0", 0) }
    let from = index * cells.count / buckets
    let to = max(from + 1, (index + 1) * cells.count / buckets)
    var level: Character = "0"
    for cell in cells[from..<min(to, cells.count)] where cell > level { level = cell }
    return (level, to - 1)
  }

  /// 22 / 45 / 70 / 100% — the four heat levels as the only thing monochrome
  /// leaves to encode them with.
  static func opacity(_ level: Character) -> Double {
    switch level {
    case "3": return 1
    case "2": return 0.7
    case "1": return 0.45
    default: return 0.22
    }
  }
}

/**
 ≈157 × 72: the eyebrow, the whole strip, and the next thing.

 The only accessory family with room for the full day, so it draws all of it —
 the same cells, the same burn-down, the same 2pt break before a new booking. The
 four levels become four opacities and nothing else changes, which is the point
 made at the top of this file.
 */
private struct RectangularFace: View {
  let entry: RidikEntry

  var body: some View {
    content.ridikAccessoryContainer()
  }

  @ViewBuilder
  private var content: some View {
    switch entry.face {
    case .ready(let snapshot), .stale(let snapshot):
      let fresh = snapshot.isToday(entry.date)
      let nowCell = fresh ? snapshot.cellIndex(at: entry.date) : snapshot.day.cells.count

      VStack(alignment: .leading, spacing: 3) {
        Text(fresh ? RidikFormat.dayLabel(snapshot.dayNoon, snapshot.timeZone) : "EARLIER")
          .font(.system(size: 10, weight: .semibold, design: .monospaced))
          .tracking(0.8)
          .lineLimit(1)

        HStack(alignment: .bottom, spacing: 0) {
          ForEach(Array(snapshot.day.cells.enumerated()), id: \.offset) { index, level in
            let spent = index < nowCell
            RoundedRectangle(cornerRadius: 1, style: .continuous)
              .fill(.white.opacity(CircularFace.opacity(level)))
              .frame(height: spent ? 6 : 14)
              .padding(.leading, index > 0 && snapshot.day.breakCells[safeLock: index] == "1" ? 2 : 0.5)
          }
        }
        .frame(height: 14, alignment: .bottom)

        Text(line(snapshot, fresh: fresh))
          .font(.system(size: 12, weight: .medium))
          .lineLimit(1)
      }
    case .blank(let reason):
      // The same two sentences the home-screen faces show, at the one size that
      // can carry them. A lock screen tile that is simply empty is the failure
      // §4 exists to prevent, and it is worse here than anywhere.
      VStack(alignment: .leading, spacing: 2) {
        Text(reason == .empty ? "Nothing published yet." : "Ridik was updated.")
          .font(.system(size: 12, weight: .semibold))
          .lineLimit(1)
        Text("Open Ridik once.")
          .font(.system(size: 11))
          .lineLimit(1)
      }
    }
  }

  private func line(_ snapshot: WidgetSnapshot, fresh: Bool) -> String {
    guard fresh else { return "Yesterday's plan" }
    guard let next = snapshot.next else { return "Nothing else today" }
    return "\(RidikFormat.clockTime(next.startDate, snapshot.timeZone))  \(next.title)"
  }
}

extension View {
  /**
   The container background an accessory family needs on iOS 17 and must not
   have before it.

   `containerBackground(for: .widget)` is required from iOS 17 — a widget without
   one is drawn with a system default and logs about it — but the accessory
   families want it *clear*, because the Lock Screen supplies its own material
   and anything opaque there fights the wallpaper it is sitting on.
   */
  @ViewBuilder
  func ridikAccessoryContainer() -> some View {
    if #available(iOS 17.0, *) {
      containerBackground(.clear, for: .widget)
    } else {
      self
    }
  }
}

/// Out-of-range is a real state: `breaks` and `load` are two strings from the
/// wire, and a build that shortened one would otherwise crash the extension.
private extension Array where Element == Character {
  subscript(safeLock index: Int) -> Character? {
    indices.contains(index) ? self[index] : nil
  }
}
