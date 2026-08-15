import SwiftUI
import WidgetKit

/**
 The family's primitives.

 Everything the five faces draw is built here, out of one shape: a rounded
 rectangle, corner radius 2, filled with the single ember colour at one of four
 opacities. The element, the plate, the rails and the debt strip are the same
 cell arranged four ways, and writing them once is what stops them drifting a
 corner radius apart on a home screen that is holding three of them at a time.

 The chrome each face shares — the eyebrow, the header, the empty note and the
 row — lives here for the same reason.
 */

// MARK: - Where a tap lands

/// The same expo-router paths the app navigates to itself.
enum Route {
  static let today = url("ridik:///today")
  static let calendar = url("ridik:///calendar")
  static let tasks = url("ridik:///tasks")
  static let habits = url("ridik:///habits")
  static let lists = url("ridik:///notes?pane=lists")

  /// A named list, so tapping the list widget opens the one it was showing.
  static func list(named name: String) -> URL {
    let encoded =
      name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    return encoded.isEmpty ? lists : url("ridik:///notes?pane=lists&list=\(encoded)")
  }

  /// Every one of these is a literal that parses. The fallback is here so that
  /// a widget can never be brought down by a URL, which is not worth crashing over.
  private static func url(_ string: String) -> URL {
    URL(string: string) ?? URL(fileURLWithPath: "/")
  }
}

// MARK: - The cell

/**
 One cell. The whole family is this and nothing else.

 Three things happen here that look like decoration and are not:

 - **A past cell keeps its level and loses 62% of its height**, bottom-aligned.
   The step in the silhouette *is* the now-marker; there is no playhead line,
   which is what lets a face survive a half-hour update period. A boundary
   twenty minutes stale looks fine; a labelled rule twenty minutes stale looks
   broken.
 - **Ink inverts on `hot` and only there.** `text` measures 3.2:1 on the ember.
 - **The hot cell is set apart differently in each scheme.** Dark gets a 1pt
   inner rim, which is invisible as a shape and reads as glow; light gets a 1pt
   inset of the ground instead, so the cell stops touching its neighbours.
   Emission versus impression — WIDGETS §5.
 */
struct HeatCell: View {
  let level: Character
  let palette: RidikPalette
  var spent: Bool = false
  var radius: CGFloat = 2

  /// What is left of a cell that is behind you.
  static let spentHeight: CGFloat = 0.38

  var body: some View {
    GeometryReader { proxy in
      let height = proxy.size.height * (spent ? Self.spentHeight : 1)
      fill
        .frame(width: proxy.size.width, height: height)
        .frame(width: proxy.size.width, height: proxy.size.height, alignment: .bottom)
    }
  }

  private var shape: RoundedRectangle {
    RoundedRectangle(cornerRadius: radius, style: .continuous)
  }

  @ViewBuilder
  private var fill: some View {
    if level == "3", let rim = palette.rim {
      shape
        .fill(palette.heatHot)
        .overlay(shape.strokeBorder(rim, lineWidth: 1))
    } else if level == "3" {
      shape.fill(palette.heatHot).padding(1)
    } else {
      shape.fill(palette.heat(level))
    }
  }
}

// MARK: - The element

/**
 The day, drawn (WIDGETS §3.1).

 One cell per `day.cellMinutes`, spanning the published window, with a hairline
 of ground before any cell a booking starts on — without it two back-to-back
 meetings are four adjacent claimed cells and read as one long block, which is a
 different and wrong answer to "how is my afternoon".

 `bucket` is how many payload cells one drawn cell stands for: 1 everywhere
 except the small Today face, where the same strip is folded into 8. Never a
 different day window — the axis underneath has to keep reading 07 / 11 / 15 /
 19 / 23 at every size.
 */
struct DayElement: View {
  let day: WidgetSnapshot.Day
  /// The cell the device's own clock is in. Negative before the window opens.
  let nowCell: Int
  let palette: RidikPalette
  var bucket: Int = 1
  var gap: CGFloat = 2

  struct Slot: Identifiable {
    let id: Int
    let level: Character
    let spent: Bool
    /// A booking starts here, so it earns a second gap of ground in front of it.
    let split: Bool
  }

  /**
   Where the drawn cells actually land, at a given width.

   Public because `DayAxis` has to lay its labels out on exactly these numbers.
   A ruler that divided the width evenly instead would put every interior label
   left of the cell it names — by 8 points on a strip whose cells are 7.6 wide,
   which is more than a whole cell of error on the one graphic the labels exist
   to explain.
   */
  struct Geometry {
    let cell: CGFloat
    /// The left edge of every slot, gaps and splits included.
    let edges: [CGFloat]

    func x(of slot: Int) -> CGFloat { edges.indices.contains(slot) ? edges[slot] : 0 }
  }

  var body: some View {
    GeometryReader { proxy in
      let slots = Self.slots(of: day, bucket: bucket, nowCell: nowCell)
      let geometry = Self.geometry(of: slots, gap: gap, width: proxy.size.width)

      HStack(spacing: 0) {
        ForEach(slots) { slot in
          HeatCell(level: slot.level, palette: palette, spent: slot.spent)
            .frame(width: geometry.cell)
            .padding(.leading, slot.id == 0 ? 0 : (slot.split ? gap * 2 : gap))
        }
      }
      .frame(width: proxy.size.width, height: proxy.size.height, alignment: .leading)
    }
  }

  /// The same arithmetic the `HStack` above performs, written down so the ruler
  /// can ask it where a cell begins.
  static func geometry(of slots: [Slot], gap: CGFloat, width: CGFloat) -> Geometry {
    let gaps = gap * CGFloat(max(0, slots.count - 1) + slots.filter(\.split).count)
    let cell = max(1, (width - gaps) / CGFloat(max(1, slots.count)))

    var edges: [CGFloat] = []
    var x: CGFloat = 0
    for slot in slots {
      if slot.id != 0 { x += slot.split ? gap * 2 : gap }
      edges.append(x)
      x += cell
    }
    return Geometry(cell: cell, edges: edges)
  }

  /**
   The strip, folded by `bucket`.

   A bucket takes the *maximum* of its cells — busy beats free, and because the
   ramp is ordered `'0'` to `'3'` that is a plain character comparison — and is
   spent only when every cell in it is behind you. The hairlines are dropped
   when folding: a boundary between two cells inside a two-hour bucket is a
   distinction the bucket has already thrown away.
   */
  static func slots(of day: WidgetSnapshot.Day, bucket: Int, nowCell: Int) -> [Slot] {
    let cells = day.cells
    let breaks = day.breakCells
    guard !cells.isEmpty else { return [] }

    let size = max(1, bucket)
    let count = Int(ceil(Double(cells.count) / Double(size)))
    return (0..<count).map { index in
      let lower = index * size
      let upper = min(cells.count, lower + size)
      let level = (lower..<upper).map { cells[$0] }.max() ?? "0"
      return Slot(
        id: index,
        level: level,
        spent: upper <= nowCell,
        split: size == 1 && lower > 0 && lower < breaks.count && breaks[lower] == "1"
      )
    }
  }
}

/**
 The ruler under the element: every fourth hour of the published window.

 Laid out on the element's own geometry rather than in equal columns. Equal
 columns are off by however much the gaps and the trailing label take out of the
 width — 8 points on a medium tile, where a cell is 7.6 wide, so "19" pointed at
 the cell before the one it named. A ruler that points at the wrong cell is
 worse than no ruler, because it is believed.
 */
struct DayAxis: View {
  let day: WidgetSnapshot.Day
  let palette: RidikPalette
  /// Must match the element above it, or the labels name the wrong cells.
  var bucket: Int = 1
  var gap: CGFloat = 2

  private struct Tick: Identifiable {
    /// The payload cell this label marks.
    let id: Int
    let label: String
    /// The drawn slot it sits over, or nil for the label at the window's end.
    let slot: Int?
  }

  var body: some View {
    let ticks = self.ticks

    // A hidden label gives the row its height: the ticks are placed by hand
    // inside a `GeometryReader`, which has no height of its own and would
    // collapse this to nothing in a `VStack`.
    Text(ticks.first?.label ?? "00")
      .font(Self.font)
      .hidden()
      .frame(maxWidth: .infinity, alignment: .leading)
      .overlay {
        GeometryReader { proxy in
          let geometry = DayElement.geometry(
            of: DayElement.slots(of: day, bucket: bucket, nowCell: 0),
            gap: gap,
            width: proxy.size.width
          )

          ZStack(alignment: .topLeading) {
            ForEach(ticks) { tick in
              label(tick, geometry: geometry)
            }
          }
          .font(Self.font)
          .foregroundStyle(palette.tertiaryText)
          .lineLimit(1)
          .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
        }
      }
  }

  private static let font = Font.system(size: 9, weight: .regular, design: .monospaced)

  @ViewBuilder
  private func label(_ tick: Tick, geometry: DayElement.Geometry) -> some View {
    if let slot = tick.slot {
      // The label's left edge on the cell's left edge — the boundary is what it
      // names, not the middle of anything.
      Text(tick.label)
        .padding(.leading, geometry.x(of: slot))
        .frame(maxWidth: .infinity, alignment: .leading)
    } else {
      // The last label sits at the window's end, so it is trailing-aligned
      // against the end of the strip rather than hung off a cell that is not there.
      Text(tick.label)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
  }

  private var ticks: [Tick] {
    let count = day.cells.count
    guard count > 0, day.cellMinutes > 0 else { return [] }

    let step = max(1, 240 / day.cellMinutes)
    let size = max(1, bucket)
    var out: [Tick] = []
    var cell = 0
    var minute = day.startMinute

    while cell <= count {
      out.append(
        Tick(
          id: cell,
          label: String(format: "%02d", (minute / 60) % 24),
          slot: cell < count ? cell / size : nil
        )
      )
      cell += step
      minute += step * day.cellMinutes
    }
    return out
  }
}

// MARK: - The plate

/**
 The month, one cell per day (WIDGETS §3.2).

 No numerals at the small size: 10pt digits in a 17pt cell are unreadable at
 arm's length, and the shape of the month is what is being read. Out-of-month
 cells are drawn clear rather than dropped — a missing child would widen the
 first and last weeks' columns and the plate would stop being a grid.
 */
struct MonthPlate: View {
  let month: WidgetSnapshot.Month
  /// Zoned, and never the device's own. See `RidikCalendar`.
  let calendar: Calendar
  let palette: RidikPalette
  /**
   Today's day of the month, or 0 for a plate that has none.

   Passed rather than read off `month.today`, because a plate published last
   month still carries a day number and drawing it would ring the wrong square
   while looking entirely deliberate.
   */
  let today: Int
  /// Nil to let the rows share whatever height the tile has left.
  var rowHeight: CGFloat? = nil
  var gap: CGFloat = 2
  var numerals: Bool = false
  /**
   Whether today is this tile's one hot cell.

   False on the large face, which also carries an element — and the element owns
   the hot there, because "the next thing" is the more urgent of the two and
   only one cell per tile may be hot. Today keeps its ring either way, so
   nothing is lost but the fill.
   */
  var todayIsHot: Bool = true

  private let rows = 6

  var body: some View {
    VStack(spacing: gap) {
      HStack(spacing: gap) {
        ForEach(letters.indices, id: \.self) { index in
          Text(letters[index])
            .font(.system(size: 9, weight: .medium, design: .monospaced))
            .foregroundStyle(palette.tertiaryText)
            .lineLimit(1)
            .frame(maxWidth: .infinity)
        }
      }

      ForEach(0..<rows, id: \.self) { row in
        HStack(spacing: gap) {
          ForEach(0..<7, id: \.self) { column in
            cell(at: row * 7 + column)
          }
        }
        .frame(height: rowHeight)
        .frame(maxHeight: rowHeight == nil ? CGFloat.infinity : nil)
      }
    }
  }

  @ViewBuilder
  private func cell(at index: Int) -> some View {
    if let number = number(at: index) {
      let level = self.level(of: number)
      HeatCell(level: level, palette: palette)
        .overlay {
          // Today is ringed whether or not it is also filled hot. In dark that
          // is the same hairline the hot cell carries; in light there is no rim
          // token, so the accent draws it — one hue either way.
          if number == today, today > 0, !todayIsHot {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
              .strokeBorder(palette.rim ?? palette.accent, lineWidth: 1)
          }
        }
        .overlay {
          if numerals {
            Text("\(number)")
              .font(.system(size: 13, weight: .medium, design: .monospaced))
              .foregroundStyle(palette.ink(on: level))
              .lineLimit(1)
              .minimumScaleFactor(0.8)
          }
        }
        .frame(maxWidth: .infinity)
    } else {
      Color.clear.frame(maxWidth: .infinity)
    }
  }

  /// The day of the month at a grid position, or nil outside it.
  private func number(at index: Int) -> Int? {
    let number = index - firstColumn + 1
    return number >= 1 && number <= month.cells.count ? number : nil
  }

  private func level(of number: Int) -> Character {
    if todayIsHot, today > 0, number == today { return "3" }
    let cells = month.cells
    return number - 1 < cells.count ? cells[number - 1] : "0"
  }

  /// Which column the 1st falls in, counted from the payload's own week start.
  private var firstColumn: Int {
    guard let first = calendar.noon(on: month.month) else { return 0 }
    return (calendar.component(.weekday, from: first) - calendar.firstWeekday + 7) % 7
  }

  private var letters: [String] {
    let symbols = calendar.veryShortWeekdaySymbols
    guard symbols.count == 7 else { return [] }
    return (0..<7).map { symbols[($0 + calendar.firstWeekday - 1) % 7] }
  }
}

// MARK: - The rails

/**
 One habit's history (WIDGETS §3.3).

 Levels are binary — logged or not — and the last cell, when it is logged, is
 today's. Cells are vertical bars rather than squares: width is the constrained
 axis on a rail of 35, so the readable dimension is bought with the one there is
 more of.
 */
struct HabitRail: View {
  /// Already windowed to the size this face draws. Last character is today.
  let history: [Character]
  let palette: RidikPalette
  /**
   Whether the last column is today.

   False on a stale face, where the rail ends on a day that is now behind you —
   lighting it would claim a habit had been logged on a day that has not
   started yet.
   */
  var marksToday: Bool = true
  var gap: CGFloat = 1.4

  var body: some View {
    HStack(spacing: gap) {
      ForEach(history.indices, id: \.self) { index in
        HeatCell(level: level(at: index), palette: palette)
          .frame(maxWidth: .infinity)
      }
    }
  }

  private func level(at index: Int) -> Character {
    guard history[index] == "1" else { return "0" }
    return marksToday && index == history.count - 1 ? "3" : "2"
  }
}

// MARK: - The debt strip

/**
 One cell per open task, oldest left (WIDGETS §3.4).

 The axis is age, not clock time: `due` in the tool contract is a full
 `YYYY-MM-DDTHH:mm`, so the model invents an hour whenever the user did not say
 one, and plotting that as a position would render fiction as data. With nothing
 open the strip is still drawn, cold and full width — an empty tile is still
 worth looking at, and a row of zeros is not.
 */
struct DebtStrip: View {
  let ages: [Int]
  let cap: Int
  let palette: RidikPalette
  var cellWidth: CGFloat = 10
  var gap: CGFloat = 2

  var body: some View {
    HStack(spacing: gap) {
      ForEach(levels.indices, id: \.self) { index in
        HeatCell(level: levels[index], palette: palette)
          .frame(width: cellWidth)
      }
      Spacer(minLength: 0)
    }
  }

  /**
   Always `cap` cells, however few tasks there are.

   The strip is a gauge, and a gauge has a full extent — two lit cells and then
   empty ground would make the tile with two tasks on it look *less* finished
   than the tile with none, which inverts the whole point of drawing the cold
   slots. WIDGETS §4: all slots present.
   */
  private var levels: [Character] {
    (0..<cap).map { index -> Character in
      guard index < ages.count else { return "0" }
      let age = ages[index]
      // The single oldest overdue task is the tile's one hot cell. Everything
      // else is a level, and nothing else on this face may be hot.
      if index == 0, age > 0 { return "3" }
      if age == 0 { return "0" }
      return age <= 2 ? "1" : "2"
    }
  }
}

// MARK: - Chrome

/// The tracked engraving that names a region, from `typography.eyebrow`.
struct Eyebrow: View {
  let text: String
  let palette: RidikPalette

  var body: some View {
    Text(text)
      .font(.system(size: 10, weight: .semibold, design: .monospaced))
      .tracking(1.2)
      .foregroundStyle(palette.accent)
      .lineLimit(1)
  }
}

/**
 The line every face opens with: what this is, which day, and one number.

 One number, in a strict priority — never two. Two counts side by side is a
 dashboard, and the point of the right slot is that whatever is in it is the
 thing worth knowing without opening anything.
 */
struct TileHeader: View {
  let eyebrow: String
  var detail: String? = nil
  var trailing: String? = nil
  let palette: RidikPalette

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Eyebrow(text: eyebrow, palette: palette)
      if let detail {
        Text(detail)
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundStyle(palette.tertiaryText)
          .lineLimit(1)
      }
      Spacer(minLength: 4)
      if let trailing {
        Text(trailing)
          .font(.system(size: 10, weight: .semibold, design: .monospaced))
          .tracking(0.8)
          .foregroundStyle(palette.accent)
          .lineLimit(1)
      }
    }
  }
}

/// The sentence an empty, stale or blank face says under its graphic.
struct EmptyNote: View {
  let headline: String
  var sub: String? = nil
  let palette: RidikPalette
  var compact: Bool = false

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(headline)
        .font(.system(size: compact ? 12 : 14, weight: .semibold, design: .rounded))
        .foregroundStyle(palette.text)
        .lineLimit(2)
        .minimumScaleFactor(0.8)
      if let sub {
        Text(sub)
          .font(.system(size: compact ? 10 : 11, weight: .medium, design: .rounded))
          .foregroundStyle(palette.secondaryText)
          .lineLimit(2)
          .minimumScaleFactor(0.8)
      }
    }
    .fixedSize(horizontal: false, vertical: true)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

// MARK: - Rows

struct RidikRow: Identifiable {
  enum Lead {
    /**
     A clock time, and the zone to read it in.

     The zone travels with the date because it is not the device's. Everything
     else on these faces — the strip, the axis, the day label, every staleness
     check — is computed in `snapshot.zone`, so a row formatted in the device's
     would show "08:00" beside a hot cell sitting at the 15:00 mark the moment
     the user is abroad, and VoiceOver would read a third time again.
     */
    case time(Date, TimeZone)
    case text(String)
    /// A checklist mark: the family's primitive at its quietest.
    case mark(Bool)

    var isTime: Bool {
      if case .time = self { return true }
      return false
    }
  }

  let id: String
  let lead: Lead
  let text: String
  var trail: String? = nil
  /// Done, ticked off, behind you — drawn struck through and dimmed.
  var spent: Bool = false
  /// What VoiceOver reads instead of "9 40 A M, Materials lab, Workshop 2".
  var spoken: String = ""
}

struct RowLine: View {
  let row: RidikRow
  let palette: RidikPalette
  var wide: Bool = true
  let leadWidth: CGFloat

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 7) {
      lead
        .frame(width: leadWidth, alignment: .leading)

      Text(row.text)
        .font(.system(size: wide ? 13 : 12, weight: .medium, design: .rounded))
        .foregroundStyle(row.spent ? palette.tertiaryText : palette.text)
        // The strikethrough is what makes a ticked row read as *done* rather
        // than as merely quieter, which grey alone does not say.
        .strikethrough(row.spent, color: palette.tertiaryText)
        .lineLimit(1)

      if let trail = row.trail, wide {
        Spacer(minLength: 6)
        // Rounded, not mono: WIDGETS §6 keeps mono for times and for tracked
        // eyebrows, and this is a place name or the word "class". The mono also
        // cost about a quarter of the column's width and truncated locations
        // the human face would have fitted.
        Text(trail)
          .font(.system(size: 10, weight: .medium, design: .rounded))
          .foregroundStyle(palette.tertiaryText)
          .lineLimit(1)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(row.spoken.isEmpty ? row.text : row.spoken)
  }

  @ViewBuilder
  private var lead: some View {
    switch row.lead {
    case .time(let date, let timeZone):
      Text(RidikFormat.clockTime(date, timeZone))
        .font(.system(size: wide ? 12 : 11, weight: .medium, design: .monospaced))
        .foregroundStyle(palette.accent)
        .lineLimit(1)
        .minimumScaleFactor(0.75)
    case .text(let text):
      Text(text)
        .font(.system(size: wide ? 12 : 11, weight: .medium, design: .monospaced))
        .foregroundStyle(palette.accent)
        .lineLimit(1)
        .minimumScaleFactor(0.75)
    case .mark(let done):
      RowMark(done: done, palette: palette)
    }
  }
}

/**
 A checklist's tick.

 Not a glyph: a 7pt cell with a point of ground around it, which is the family's
 primitive at its quietest and the only mark on the one face that has no
 graphic. Open is cold, done is claimed — the same two levels the rest of the
 family uses for the same two meanings.
 */
struct RowMark: View {
  let done: Bool
  let palette: RidikPalette

  var body: some View {
    HeatCell(level: done ? "2" : "0", palette: palette)
      .frame(width: 7, height: 7)
      .padding(1)
  }
}

/**
 The lead column is fixed so the rows line up.

 A monospaced 24-hour time is the same width on every row, but "9:40 AM" and
 "12:40 PM" are not, and left to themselves each row would indent its title
 differently. The width comes from the device's own clock setting rather than
 from measurement, because a widget cannot measure before it draws.
 */
func ridikLeadWidth(for rows: [RidikRow], wide: Bool) -> CGFloat {
  if rows.contains(where: { if case .mark = $0.lead { return true } else { return false } }) {
    return 9
  }
  guard rows.contains(where: \.lead.isTime) else { return 22 }
  let twelveHour = (DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .current) ?? "")
    .contains("a")
  return twelveHour ? (wide ? 60 : 54) : (wide ? 42 : 38)
}

// MARK: - Words

/// Every string a face formats. Locale-aware; none of it is in the payload.
enum RidikFormat {
  /// "THU 13" — the day the payload describes, in the payload's zone.
  static func dayLabel(_ date: Date, _ timeZone: TimeZone) -> String {
    localized(date, template: "EEEd", timeZone).uppercased()
  }

  /// "August" — the plate's own month, sentence case for a sentence.
  static func monthName(_ date: Date, _ timeZone: TimeZone) -> String {
    localized(date, template: "MMMM", timeZone)
  }

  /// "6h 30m", "45m", "6h". Never "0h 45m".
  static func duration(_ minutes: Int) -> String {
    let hours = minutes / 60
    let rest = minutes % 60
    if hours == 0 { return "\(rest)m" }
    if rest == 0 { return "\(hours)h" }
    return "\(hours)h \(rest)m"
  }

  /// "twelve" — a number in a sentence is a word, not a numeral.
  static func spelled(_ number: Int) -> String {
    let formatter = NumberFormatter()
    formatter.locale = .current
    formatter.numberStyle = .spellOut
    return formatter.string(from: NSNumber(value: number)) ?? "\(number)"
  }

  /// How many days late, counted in whole local days rather than in hours.
  static func daysLate(_ due: Date, at now: Date, _ calendar: Calendar) -> Int {
    let from = calendar.startOfDay(for: due)
    let to = calendar.startOfDay(for: now)
    return max(1, calendar.dateComponents([.day], from: from, to: to).day ?? 1)
  }

  /**
   A visible clock time, in the payload's zone.

   Never `Text(date, style: .time)`, which renders in the *device's* zone while
   every other number on the face is computed in `snapshot.zone`: fly east and
   the same row reads "08:00" against a hot cell at the 15:00 mark, and its own
   VoiceOver label says "3:00 PM" because `spokenTime` pins the zone and this
   did not. The locale stays the device's, so its 12/24-hour setting still
   decides the shape — only the zone is taken from the payload.
   */
  static func clockTime(_ date: Date, _ timeZone: TimeZone) -> String {
    localized(date, template: "jmm", timeZone)
  }

  /// VoiceOver gets the same instant spelled out, in the same zone.
  static func spokenTime(_ date: Date, _ timeZone: TimeZone) -> String {
    let formatter = DateFormatter()
    formatter.locale = .current
    formatter.timeZone = timeZone
    formatter.timeStyle = .short
    formatter.dateStyle = .none
    return formatter.string(from: date)
  }

  private static func localized(_ date: Date, template: String, _ timeZone: TimeZone) -> String {
    let formatter = DateFormatter()
    formatter.locale = .current
    formatter.timeZone = timeZone
    formatter.setLocalizedDateFormatFromTemplate(template)
    return formatter.string(from: date)
  }
}

extension String {
  /// A location that arrived as "" would otherwise draw an empty trailing column.
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
