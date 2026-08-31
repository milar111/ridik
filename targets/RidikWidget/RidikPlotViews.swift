import SwiftUI
import WidgetKit

/**
 The four expressive faces: Skyline, Sundial, Route and Term.

 One file, because they are one face four times — a header, a single graphic, a
 line under it, and the same staleness and empty rules as everything else. The
 only thing that differs is the shape, which is what `PlotShape` selects. The
 Android side collapses the same four into one `plotted()` draw for the same
 reason: four copies of the surrounding scaffolding would be four places for the
 two platforms to drift apart.

 ## Three of these are alternatives to Today, not companions to it

 Skyline gives a cell a height *and* a level, which is exactly §8's objection to
 a second encoding of one variable. Sundial and Route trade the strip's
 countability for a position that can be read across a room. None of the three
 should sit on a home screen beside Today, and each blurb in the picker says so —
 that is where the choice is made, and it is the only place it can be.

 Term is the exception and composes with anything, because it counts days rather
 than measuring them. Beside Sundial the two do not argue: one is a position, the
 other a count, and neither pretends to be the other.

 ## Where Android has to raster, SwiftUI draws

 `RemoteViews` cannot set a width or a height before API 31, cannot draw a curve
 at all, and cannot hold 365 views — so `RidikPlots.kt` makes each of these a
 white alpha mask tinted by the layout. Here they are ordinary SwiftUI shapes,
 which is why this file is a third the size and why the two must be read
 together: the *numbers* are the same numbers, and the arithmetic below is
 written to match that file line for line.
 */
enum PlotShape {
  case skyline
  case sundial
  case route
}

/// The four levels as opacities. Matches `RidikPlots.ALPHA`.
private let plotAlpha: [Double] = [0.18, 0.36, 0.66, 1]

/// What is left of a cell that is behind you. Matches `HeatCell.spentHeight`.
private let plotSpent: CGFloat = 0.38

private func alphaOf(_ level: Character, spent: Bool) -> Double {
  let index = min(max(Int(String(level)) ?? 0, 0), 3)
  return plotAlpha[index] * (spent ? 0.55 : 1)
}

/**
 The scaffolding all four share: header, graphic, note, empty copy.

 `plot` is a closure rather than a generic view parameter so that the four faces
 stay four small structs — each one is a size table and a sentence, and the shape
 it draws.
 */
private struct PlotScaffold<Plot: View>: View {
  let entry: RidikEntry
  let compact: Bool
  let eyebrow: String
  let trailing: String?
  let note: String?
  let headline: String?
  let sub: String?
  /**
   `nil` lets the graphic take whatever the tile has left.

   Every one of these faces used to be pinned to a fixed height, which left a
   third of a medium tile as ground under a small drawing — correct in shape and
   cheap to look at. What made that necessary was the sun and the puck being
   sized from the height alone, so a taller box inflated them into blots; they
   are clamped against the horizontal step now, so the box is free to grow and
   the ornaments on it are not. Route keeps a fixed height because it is a
   *line*, and a line cannot be made taller without becoming a band.
   */
  let height: CGFloat?
  let palette: RidikPalette
  @ViewBuilder let plot: () -> Plot

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      TileHeader(eyebrow: eyebrow, trailing: trailing, palette: palette)

      if let height {
        // Route alone, and *centred* rather than pushed.
        //
        // One `Spacer` under a 30-point plot used to put the whole of a medium
        // tile's slack — about 53 points — into a single hole between the line
        // and the caption, which read as a face with something missing from the
        // middle of it. The same slack split above and below reads as a line
        // sitting in the middle of its tile, which is what it is. The plot is
        // still a fixed height: everything drawn on it is sized from its own
        // box, so letting it grow would draw a different picture rather than a
        // bigger one.
        Spacer(minLength: 4)
        plot()
          .frame(height: height)
        Spacer(minLength: 4)
      } else {
        plot()
          .frame(maxHeight: .infinity)
          .padding(.top, 10)
          .padding(.bottom, 6)
      }

      if let note {
        Text(note)
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(palette.secondaryText)
          .lineLimit(1)
      }

      // Staleness is said in words and never by taking the drawing away: a
      // spent day is a legitimate reading of a day, and a blank tile is not.
      if let headline {
        EmptyNote(headline: headline, sub: sub, palette: palette, compact: compact)
      }
    }
    .ridikTilePadding()
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .ridikGround(palette)
  }
}

/* ------------------------------------------------------------------ the day */

/**
 One face for Skyline, Sundial and Route — they read the same three fields and
 differ only in what they draw with them.
 */
private struct DayPlot: View {
  @Environment(\.widgetFamily) var family
  @Environment(\.colorScheme) var colorScheme

  let entry: RidikEntry
  let shape: PlotShape
  /// `nil` means "fill the tile" — see `PlotScaffold.height`.
  let height: CGFloat?

  private var compact: Bool { family == .systemSmall }

  var body: some View {
    let palette = RidikPalette.of(scheme: colorScheme, ember: entry.face.ember)

    Group {
      switch entry.face {
      case .ready(let snapshot), .stale(let snapshot):
        face(snapshot, palette: palette)
      case .blank(let reason):
        NoticePane(reason: reason, palette: palette, compact: compact)
          .ridikTilePadding()
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .ridikGround(palette)
      }
    }
    .widgetURL(Route.today)
  }

  @ViewBuilder
  private func face(_ snapshot: WidgetSnapshot, palette: RidikPalette) -> some View {
    let now = entry.date
    let fresh = snapshot.isToday(now)
    // Past the end of the strip when the payload is not today's: every cell then
    // reads as spent, which is what a day that has ended looks like and is what
    // makes a stale tile *look* stale rather than current.
    let spentThrough = fresh ? snapshot.cellIndex(at: now) - 1 : snapshot.day.cells.count
    let next = fresh ? snapshot.next : nil

    PlotScaffold(
      entry: entry,
      compact: compact,
      eyebrow: fresh ? RidikFormat.dayLabel(snapshot.dayNoon, snapshot.timeZone) : "EARLIER",
      trailing: snapshot.tasks.overdue > 0 ? "\(snapshot.tasks.overdue) LATE" : nil,
      note: next.map { "\(RidikFormat.clockTime($0.startDate, snapshot.timeZone))  ·  \($0.title)" },
      headline: fresh ? (next == nil ? "Nothing else today." : nil) : "Yesterday's plan.",
      sub: fresh ? nil : "Open Ridik to refresh it.",
      height: height,
      palette: palette
    ) {
      graphic(snapshot, spentThrough: spentThrough, palette: palette)
    }
  }

  @ViewBuilder
  private func graphic(
    _ snapshot: WidgetSnapshot,
    spentThrough: Int,
    palette: RidikPalette
  ) -> some View {
    let cells = snapshot.day.cells
    let breaks = snapshot.day.breakCells

    switch shape {
    case .skyline:
      Skyline(cells: cells, breaks: breaks, spentThrough: spentThrough, palette: palette)
    case .sundial:
      Sundial(cells: cells, spentThrough: spentThrough, palette: palette)
    case .route:
      RouteLine(cells: cells, breaks: breaks, spentThrough: spentThrough, palette: palette)
    }
  }
}

/**
 Skyline — the same 32 cells, but their height is their level.

 A flat strip tells you *when* you are busy; a silhouette tells you *how* busy,
 because height is read pre-attentively where four opacities are not. Burn-down
 still marks now: a spent block keeps its height and drops to the same 38% the
 strip's cells do, so the step at `now` survives and the face can still show that
 it has gone stale.
 */
private struct Skyline: View {
  let cells: [Character]
  let breaks: [Character]
  let spentThrough: Int
  let palette: RidikPalette

  var body: some View {
    GeometryReader { proxy in
      let step = proxy.size.width / CGFloat(max(cells.count, 1))
      // The floor is what stops a clear day being an invisible tile: a level-0
      // block is a thin plinth rather than nothing at all.
      let floor = proxy.size.height * 0.12
      ZStack(alignment: .bottomLeading) {
        ForEach(Array(cells.enumerated()), id: \.offset) { index, level in
          let spent = index <= spentThrough
          let share = CGFloat(min(max(Int(String(level)) ?? 0, 0), 3)) / 3
          let full = floor + (proxy.size.height - floor) * share
          let gap: CGFloat = breaks[safe: index] == "1" ? 3 : 1.5
          RoundedRectangle(cornerRadius: 2, style: .continuous)
            .fill(palette.accent.opacity(alphaOf(level, spent: spent)))
            .frame(width: max(step - gap, 1), height: spent ? full * plotSpent : full)
            .offset(x: CGFloat(index) * step)
        }
      }
      .frame(width: proxy.size.width, height: proxy.size.height, alignment: .bottomLeading)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("The day as a skyline, taller where it is busier")
  }
}

/**
 Sundial — the day's cells laid on a curve, with a disc riding it at `now`.

 The amendment this face needs is one sentence and it is written into §1: *a path
 carrying a position marker is permitted; a closed ring encoding a fraction is
 not.* The distinction is real rather than a loophole — a progress ring says "62%
 of a goal" and invites you to compare two of them; this says "you are here,
 between these two ends", which is what the strip's burn-down step already says,
 drawn so that it can be read across a room. Nothing here encodes a proportion.

 The curve is a **quadratic** with its control point at the horizontal midpoint,
 which makes `x(t) = x0 + t·(x1 − x0)` exactly — so `t` is the fraction of the
 window elapsed and no numeric inversion is needed. The same arithmetic as
 `src/features/today/arc.ts` and `RidikPlots.sundial`, deliberately, so the app
 screen and both platforms' tiles put the sun in the same place.
 */
private struct Sundial: View {
  let cells: [Character]
  let spentThrough: Int
  let palette: RidikPalette

  /**
   The curve, as arithmetic rather than as a closure inside the body.

   A local function with a `return` in it cannot live in a `ViewBuilder` body —
   the builder rejects the statement outright — and this is worth having as a
   value anyway: it is the one piece of geometry the app screen and both
   platforms' tiles have to agree on exactly.
   */
  struct Geometry {
    let size: CGSize
    /// How many dots share the arc — the dot radius is clamped against it.
    let cells: Int

    var inset: CGFloat { size.width * 0.05 }
    var step: CGFloat { size.width / CGFloat(max(cells, 1)) }

    /**
     Clamped against the step as well as the height, exactly like `dot`.

     The disc is a sun riding the arc. Sized from the box alone it grows with any
     tile that is taller than it is dense, and past about one step wide it stops
     being a marker and becomes a blot covering the hours it is sitting on.
     `RidikPlots.sundial` and `sundialGeometry` in the Android plugin clamp
     identically.
     */
    var disc: CGFloat { min(size.height * 0.13, step * 0.95) }

    /**
     Clamped against the *step* and not only against the height.

     A dot sized purely from the arc's height overlaps its neighbours as soon as
     the tile is narrow, and thirty-two overlapping dots is a caterpillar rather
     than a row of half hours. Nothing about a dot means anything once it
     touches the one beside it. `RidikPlots.sundial` and `sundialGeometry` in the
     Android plugin clamp identically.
     */
    var dot: CGFloat { min(size.height * 0.055, step * 0.38) }
    /// Room for the disc at either end of the sweep, top and bottom.
    var base: CGFloat { size.height - disc - 2 }
    var peak: CGFloat { disc + 2 }
    /// A quadratic passes at half its control point's offset, so the control is
    /// lifted to twice the height the curve should actually reach.
    var control: CGFloat { base - (base - peak) * 2 }

    /**
     The point at `t` along the curve, where `t` is the fraction of the window
     elapsed — exactly, with no numeric inversion, because the control point is
     at the horizontal midpoint and that makes `x(t)` linear in `t`. The same
     arithmetic as `src/features/today/arc.ts` and `RidikPlots.sundial`.
     */
    func at(_ t: CGFloat) -> CGPoint {
      let u = 1 - t
      return CGPoint(
        x: inset + t * (size.width - inset * 2),
        y: u * u * base + 2 * u * t * control + t * t * base
      )
    }
  }

  var body: some View {
    GeometryReader { proxy in
      let g = Geometry(size: proxy.size, cells: cells.count)

      ZStack(alignment: .topLeading) {
        // The track, drawn first and faintly, so a day with nothing on it is
        // still a drawing rather than a blank tile.
        Path { path in
          path.move(to: g.at(0))
          path.addQuadCurve(to: g.at(1), control: CGPoint(x: g.size.width / 2, y: g.control))
        }
        .stroke(palette.accent.opacity(plotAlpha[0]), lineWidth: 1.5)

        ForEach(Array(cells.enumerated()), id: \.offset) { index, level in
          let spent = index <= spentThrough
          // The centre of the cell rather than its edge: a dot marks a span, and
          // putting it on the boundary reads as half an hour early all day.
          let point = g.at((CGFloat(index) + 0.5) / CGFloat(max(cells.count, 1)))
          // Behind you the dots *shrink* rather than burn down — a curve has no
          // baseline for a cell to burn towards.
          let r = spent ? g.dot * 0.55 : g.dot
          Circle()
            .fill(palette.accent.opacity(alphaOf(level, spent: spent)))
            .frame(width: r * 2, height: r * 2)
            .offset(x: point.x - r, y: point.y - r)
        }

        // The disc is the tile's one hot object, so §1.1 still holds.
        if spentThrough >= 0, spentThrough < cells.count {
          let point = g.at((CGFloat(spentThrough) + 1) / CGFloat(max(cells.count, 1)))
          Circle()
            .fill(palette.accent)
            .frame(width: g.disc * 2, height: g.disc * 2)
            .offset(x: point.x - g.disc, y: point.y - g.disc)
        }
      }
      .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("The day as an arc, with a marker at now")
  }
}

/**
 Route — the day as a line, its events as segments, and now as a puck.

 Transit's lock-screen widget, transferred directly. Spent segments thin behind
 you rather than burning down, because a horizontal line has no baseline to burn
 towards — the same substitution Sundial makes for the same reason.

 It is honest about position and not about duration: a puck wide enough to see is
 about twenty-five minutes of a day, so it reads as *where you are* and never as
 *how long this takes*. That is said here because it is the one thing about this
 face that could be mistaken for a measurement.
 */
private struct RouteLine: View {
  let cells: [Character]
  let breaks: [Character]
  let spentThrough: Int
  let palette: RidikPalette

  var body: some View {
    GeometryReader { proxy in
      let w = proxy.size.width
      let h = proxy.size.height
      let step = w / CGFloat(max(cells.count, 1))
      // 27%, not 34%. The box grew from 30 points to 44 so the caption would
      // stop being pushed to the floor by a 53-point hole, and 34% of 44 is a
      // band rather than a line. A ratio rather than a cap, so that the two
      // platforms cannot drift if the box is ever retuned: `RidikPlots.route`
      // takes the same 0.27 of the same box.
      let thick = h * 0.27
      let thin = thick * 0.42
      // Clamped against the segment step: Transit's puck is a marker sitting on
      // a line and stops being one the moment it is wider than a few segments —
      // past that it is a blot over the part of the day it points at.
      let puckR = min(h * 0.5, step * 1.6)

      ZStack(alignment: .leading) {
        // **The line is continuous, and the rounding is on its ends.**
        //
        // Every segment used to be its own capsule with a hairline of ground
        // after it, and at thirty-two segments across a tile that is ten points
        // wide by nine tall — which is a bead. The face drew as a row of them
        // rather than as a route, which is the whole metaphor gone. So the
        // segments butt against each other, a gap is left only where a booking
        // actually begins, and the *rail* carries the caps: clipped once here
        // rather than thirty-two times. `RidikPlots.route` clips the same shape.
        ZStack(alignment: .leading) {
          // **The track, and why the claim above needed it to exist.**
          //
          // "Continuous" was a claim about the *clip*, not about what got drawn
          // into it, and for the first half of every day it was simply false. An
          // empty cell is level 0, which is 18% of the accent; a *spent* one is
          // that times 0.55, which is ten. Ten per cent of an ember over a pale
          // tile, four points tall, is nothing at all — so the whole morning of
          // an ordinary day rendered as blank ground and the route began at the
          // puck. The face read as a slider someone had dragged, which is the
          // one thing it must not: a journey with no road behind you.
          //
          // Burn-down cannot answer this the way it does on Skyline, because
          // that face has a baseline to shrink towards and a line has none. So
          // the road is drawn first, full width, and the day is drawn on top of
          // it. Spent cells still thin and still dim; they now thin against
          // something. `RidikPlots.route` lays the same track first.
          Capsule()
            .fill(palette.accent.opacity(0.13))
            .frame(width: w, height: thick)

          ForEach(Array(cells.enumerated()), id: \.offset) { index, level in
            let spent = index <= spentThrough
            let bar = spent ? thin : thick
            // No gap between two cells of the same booking — only where one starts.
            let gap: CGFloat = breaks[safe: index] == "1" ? 2.5 : 0
            Rectangle()
              .fill(palette.accent.opacity(alphaOf(level, spent: spent)))
              .frame(width: max(step - gap, 1), height: bar)
              .offset(x: CGFloat(index) * step)
          }
        }
        // The rail's *own* box, not the whole plot area: a capsule clipped to a
        // box taller than the line rounds the corners of the air around it and
        // leaves the line's ends square.
        .frame(width: w, height: thick)
        .clipShape(Capsule())
        .frame(width: w, height: h)

        if spentThrough >= 0, spentThrough < cells.count {
          let x = (CGFloat(spentThrough) + 1) / CGFloat(max(cells.count, 1)) * w
          Circle()
            .fill(palette.accent)
            .frame(width: puckR * 2, height: puckR * 2)
            // Clamped inside the tile: a puck at the last cell would be half
            // outside it and read as a clipped rectangle rather than a marker.
            .offset(x: min(max(x, puckR), w - puckR) - puckR)
        }
      }
      .frame(width: w, height: h, alignment: .leading)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("The day as a route, with a marker at now")
  }
}

/* ----------------------------------------------------------------- the term */

/**
 Term — one dot per day, and the ones behind you.

 Lifted almost whole from *one year*, and the only one of the four that needed no
 amendment at all: a dot is the cell at its smallest, burn-down is already the
 rule for what is past, and today is the one hot one.

 It reads no load, which is what lets it sit beside Sundial without the two
 arguing about what a cell means — one is a count of days, the other a measure of
 them.

 There is no *term*, because the app models none. Small draws the month and
 medium the year, which are the two periods a calendar actually has; naming a
 semester the user never entered would be the face inventing its own data.
 */
private struct TermPlot: View {
  @Environment(\.widgetFamily) var family
  @Environment(\.colorScheme) var colorScheme

  let entry: RidikEntry

  private var compact: Bool { family == .systemSmall }

  var body: some View {
    let palette = RidikPalette.of(scheme: colorScheme, ember: entry.face.ember)

    Group {
      switch entry.face {
      // No staleness branch, deliberately: which day of the year it is does not
      // stop being true because the app has not been opened, and the payload's
      // own date is what this counts from.
      case .ready(let snapshot), .stale(let snapshot):
        face(snapshot, palette: palette)
      case .blank(let reason):
        NoticePane(reason: reason, palette: palette, compact: compact)
          .ridikTilePadding()
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .ridikGround(palette)
      }
    }
    .widgetURL(Route.calendar)
  }

  @ViewBuilder
  private func face(_ snapshot: WidgetSnapshot, palette: RidikPalette) -> some View {
    let period = Self.period(snapshot.day.date, month: compact) ?? Self.fallback(month: compact)

    PlotScaffold(
      entry: entry,
      compact: compact,
      eyebrow: period.label,
      trailing: "DAY \(period.elapsed + 1)",
      note: period.left == 1 ? "1 day left" : "\(period.left) days left",
      // The last day of a period is a real reading, not an empty state — the
      // note already says "0 days left".
      headline: nil,
      sub: nil,
      height: nil,
      palette: palette
    ) {
      Dots(
        total: period.total,
        elapsed: period.elapsed,
        columns: compact ? 7 : 31,
        palette: palette
      )
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Day \(period.elapsed + 1) of \(period.total), \(period.left) left")
    }
  }

  struct Period {
    let label: String
    let total: Int
    /// Days completed, which is also the index of today.
    let elapsed: Int
    var left: Int { total - elapsed - 1 }
  }

  /**
   The month or the year the payload's own day falls in.

   The payload's day and never the device's: a tile published in another zone
   must not count a day the user has not had yet.
   */
  static func period(_ date: String, month: Bool) -> Period? {
    let parts = date.split(separator: "-")
    guard parts.count == 3,
          let year = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2])
    else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
    guard let day = calendar.date(from: DateComponents(year: year, month: m, day: d)),
          let unit = calendar.range(of: .day, in: month ? .month : .year, for: day)
    else { return nil }

    if month {
      let name = calendar.monthSymbols[min(max(m - 1, 0), 11)].uppercased()
      return Period(label: name, total: unit.count, elapsed: d - 1)
    }
    let ordinal = calendar.ordinality(of: .day, in: .year, for: day) ?? 1
    return Period(label: "\(year)", total: unit.count, elapsed: ordinal - 1)
  }

  /// A payload whose date will not parse still draws: an empty period is the
  /// same drawing with nothing behind you, which is §4's rule.
  static func fallback(month: Bool) -> Period {
    Period(label: month ? "MONTH" : "YEAR", total: month ? 30 : 365, elapsed: 0)
  }
}

/// The dot field itself. Nothing about it reads a load — see `TermPlot`.
private struct Dots: View {
  let total: Int
  let elapsed: Int
  let columns: Int
  let palette: RidikPalette

  var body: some View {
    GeometryReader { proxy in
      let rows = max((total + columns - 1) / columns, 1)
      let cellW = proxy.size.width / CGFloat(columns)
      let cellH = proxy.size.height / CGFloat(rows)
      // The smaller axis, so a wide short tile does not draw ellipses.
      let r = max(min(cellW, cellH) / 2 - 0.6, 0.6)

      ZStack(alignment: .topLeading) {
        ForEach(0..<total, id: \.self) { index in
          let cx = CGFloat(index % columns) * cellW + cellW / 2
          let cy = CGFloat(index / columns) * cellH + cellH / 2
          let behind = index < elapsed
          let today = index == elapsed
          // Full size throughout, and only the opacity moves. §1.3's burn-down
          // is a *height* rule and a dot has no height to take 38% of —
          // shrinking one takes the ink away in both axes at once, which drew
          // the days behind you as a faint speckle under solid ones ahead. The
          // past has to be the filled mass; that is how `one year`, the app this
          // is lifted from, draws it, and it is what the face is for.
          let size = r * 2
          Circle()
            .fill(palette.accent.opacity(behind ? 0.5 : today ? 1 : plotAlpha[0]))
            .frame(width: size, height: size)
            .offset(x: cx - size / 2, y: cy - size / 2)
        }
      }
      .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
    }
  }
}

/* --------------------------------------------------------------- the widgets */

struct RidikHorizonView: View {
  let entry: RidikEntry

  var body: some View {
    DayPlot(entry: entry, shape: .skyline, height: nil)
  }
}

struct RidikSundialView: View {
  let entry: RidikEntry

  var body: some View {
    DayPlot(entry: entry, shape: .sundial, height: nil)
  }
}

struct RidikRouteView: View {
  let entry: RidikEntry

  var body: some View {
    // The one fixed height in the family: a route is a line, and a line cannot
    // be made taller without becoming a band. Android gives it a one-row tile
    // for the same reason; WidgetKit has no such family, so it keeps medium and
    // the line sits above its caption rather than being stretched to fill.
    DayPlot(entry: entry, shape: .route, height: 44)
  }
}

struct RidikTermView: View {
  let entry: RidikEntry

  var body: some View { TermPlot(entry: entry) }
}

/// Out-of-range is a real state here: `breaks` and `load` are two strings from
/// the wire and a build that shortened one would otherwise crash the extension.
private extension Array where Element == Character {
  subscript(safe index: Int) -> Character? {
    indices.contains(index) ? self[index] : nil
  }
}
