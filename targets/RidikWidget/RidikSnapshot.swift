import Foundation

/**
 The widget's half of the payload defined by `src/services/widgets/snapshot.ts`.

 Deliberately a separate declaration rather than anything shared: this file is
 compiled into the extension, which links neither the app nor React Native, and
 the only thing the two processes exchange is a string of JSON in a shared
 container.

 Epoch milliseconds arrive as JSON numbers and are decoded as `Double`. They are
 whole numbers well inside the range a `Double` represents exactly, and keeping
 them as one avoids an `Int64`/`Int` split between simulator and device.

 The visualisations arrive as strings of digits — one character per cell, `'0'`
 to `'3'`. That is not a compression trick: it is what lets the extension own the
 palette. An app that published colours would publish the ones it was rendering
 with, and a launcher in dark mode would get a light-mode tile.
 */
struct WidgetSnapshot: Decodable {
  /**
   The day, as a strip of half-hour cells.

   The window is fixed rather than fitted to the day's own events, so the same
   day is the same picture at 09:00 and at 21:00. Everything about "now" —
   which cells have burned down, how much is unclaimed — is computed by the
   widget from its own clock against `zone`, which is why this survives a
   half-hour update period without looking broken.
   */
  struct Day: Decodable {
    /// 'YYYY-MM-DD' in `zone`. The one field that decides whether this is today.
    let date: String
    /// Minutes past local midnight of cell 0.
    let startMinute: Int
    let cellMinutes: Int
    /// One heat character per cell, earliest first.
    let load: String
    /// '1' where a new booking begins. Drawn as a hairline of ground before it.
    let breaks: String
    /// Index into `load` of the next thing's first cell, or -1.
    let nextCell: Int
    /// Minutes of the whole window with nothing in them — never "left today".
    let freeMinutes: Int

    var cells: [Character] { Array(load) }
    var breakCells: [Character] { Array(breaks) }

    // There is deliberately no `cold` day here any more. A face with no payload
    // at all draws `NoticePane` and nothing else — WIDGETS §4 keeps the whole
    // tile for exactly "nothing published" and "wrong version" — and a default
    // 07:00-to-23:00 window invented by the extension was a picture of a day it
    // had never been told anything about, on the two states where saying so is
    // the entire job. Every empty state that *does* have a payload behind it
    // still draws its graphic, from that payload.
  }

  /**
   The month, as a plate of one cell per day.

   `load` only ever reaches `mid`; `hot` is today, and the renderer applies it —
   a plate with a hot cell on the 3rd and another on the 19th has no focus at
   all. `today` is 0 when the plate is not the current month, which is also the
   signal that the plate itself has gone stale.
   */
  struct Month: Decodable {
    /// 'YYYY-MM'.
    let month: String
    /// 1 = Monday. Which column the grid starts on.
    let weekStartsOn: Int
    /// One character per day, the 1st first. Only '0', '1' or '2'.
    let load: String
    /**
     Day of the month that was today *when this was published*, or 0 when the
     plate is not the current month.

     Not what the plate rings: that is recomputed on the device by
     `dayOfMonth(_:)`. Kept because 0 still says "this plate is a past month",
     which is a month-level fact and does not go stale overnight.
     */
    let today: Int

    var cells: [Character] { Array(load) }

    // No `cold` plate either, and for the same reason as the day above: the
    // calendar's blank tile is a notice now. A clear *month* — which is a
    // payload saying nothing is booked — still draws its full plate.
  }

  /**
   Whether the user has ever set each thing up.

   The difference between "you have done everything" and "you have never set
   this up" — which render identically without it, and that single missing
   distinction is most of why an untouched install's widgets look broken.
   */
  struct Configured: Decodable {
    let calendar: Bool
    let tasks: Bool
    let habits: Bool
    let lists: Bool
  }

  struct Next: Decodable {
    let title: String
    let startsAt: Double
    let leaveAt: Double?
    let location: String?

    var startDate: Date { Date(epochMilliseconds: startsAt) }
    var leaveDate: Date? { leaveAt.map(Date.init(epochMilliseconds:)) }
  }

  struct AgendaRow: Decodable, Identifiable {
    let title: String
    let startsAt: Double
    let endsAt: Double
    /// "event" or "class"; the builder has already dropped travel buffers.
    let kind: String
    let location: String?

    var startDate: Date { Date(epochMilliseconds: startsAt) }
    var endDate: Date { Date(epochMilliseconds: endsAt) }
    /// Stable within one face, which is all a `ForEach` over six rows needs.
    var id: String { "\(startsAt)-\(title)" }
  }

  struct TaskRow: Decodable, Identifiable {
    let title: String
    /// Absent for a task that is due today with no time on it.
    let dueAt: Double?
    let overdue: Bool

    var dueDate: Date? { dueAt.map(Date.init(epochMilliseconds:)) }
    var id: String { "\(dueAt ?? 0)-\(title)" }
  }

  struct HabitRow: Decodable, Identifiable {
    let name: String
    let doneToday: Bool
    let streak: Int
    let longestStreak: Int
    /// `historyDays` characters of '0'/'1', oldest first, the last one `day.date`.
    let history: String

    var id: String { name }

    /// Days of history the payload carries — five weeks, the largest window.
    static let historyDays = 35

    /**
     The last `days` characters — the window this face draws (WIDGETS §3.3).

     Short-padded on the left rather than trimmed on the right: the *last*
     character is today, and a rail that quietly shifted today one column left
     would put every weekday letter over the wrong cell.
     */
    func window(_ days: Int) -> [Character] {
      let characters = Array(history)
      if characters.count >= days { return Array(characters.suffix(days)) }
      return Array(repeating: "0", count: days - characters.count) + characters
    }
  }

  struct ListRow: Decodable {
    let text: String
    let done: Bool

    /**
     Identity, and why it needs the position.

     A checklist holds whatever the user said, which includes the same words
     twice — "M4 bolts" for two different jobs, "milk" written down on Monday
     and again on Thursday. Two `ForEach` children with the same id are one
     child as far as SwiftUI is concerned, so the tile would quietly draw four
     rows for a list of five and nothing anywhere would fail. `AgendaRow` and
     `TaskRow` fold their time in for exactly this reason; a list has no time,
     so it folds in where it sits.
     */
    func id(at offset: Int) -> String { "\(offset)-\(text)" }
  }

  struct Tasks: Decodable {
    let dueToday: Int
    let overdue: Int
    /// Days overdue per open task, oldest first. 0 is "due today".
    let ages: [Int]
    /// Overdue first, then by due time. Capped by the publisher, not here.
    let rows: [TaskRow]

    /// Every task the ages strip has a cell for — the footer's "12 open".
    var open: Int { dueToday + overdue }
  }

  struct Habits: Decodable {
    let done: Int
    let total: Int
    /// Creation order, and never any other. A rail is read down its columns.
    let rows: [HabitRow]
  }

  struct Checklist: Decodable {
    let name: String
    /// Counted before the rows were capped, so it is the whole list's answer.
    let open: Int
    /**
     Every item on the list, counted before the cap as well.

     The tile is asked to be a tally — "4 OF 12" — and the rows it is handed are
     the first six. Counting those was the only thing available before this
     field existed, and it made the header say "4 OF 6" about a list of twelve.
     */
    let total: Int
    let rows: [ListRow]
  }

  let version: Int
  let publishedAt: Double
  /// The IANA zone the day was computed in. A widget must never guess this.
  let zone: String
  /**
   The ember the user chose — `"ember"`, `"kiln"` or `"rust"`.

   Optional so that the *version* field stays the one thing that decides whether
   a payload can be drawn: a build that adds a fourth ember, or drops this one,
   should say "Ridik was updated" rather than fail to decode for a reason the
   reader cannot see. `RidikEmber.named` treats anything it does not know as the
   default. Unlike the scheme, this does travel — see `RidikPalette.of`.
   */
  let ember: String?
  let day: Day
  let month: Month
  let configured: Configured
  let next: Next?
  let tasks: Tasks
  let habits: Habits
  /// What is left of today, in order. Empty once the day is behind you.
  let agenda: [AgendaRow]
  /// All-day titles. A calendar that silently omits them loses whole days.
  let allDay: [String]
  /// The list worth showing — the first with anything open on it.
  let list: Checklist?

  var publishedDate: Date { Date(epochMilliseconds: publishedAt) }
}

// MARK: - Now, in the payload's own zone

/**
 The one calendar every face measures against.

 Gregorian and explicitly zoned, never `Calendar.current`: the device's zone is
 right until the user is travelling, and then every face is wrong by hours while
 looking entirely plausible. `locale` is the device's, because the weekday
 letters and month names are read by a person and the grid's Monday start comes
 from the payload instead.
 */
enum RidikCalendar {
  static func make(timeZone: TimeZone, weekStartsOn: Int) -> Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    calendar.locale = .current
    // The payload counts Monday as 1; `Calendar` counts Sunday as 1.
    calendar.firstWeekday = max(1, min(7, weekStartsOn + 1))
    return calendar
  }

  /// For faces with no payload to take a zone from. Monday-first, like the app.
  static var device: Calendar { make(timeZone: .current, weekStartsOn: 1) }
}

extension Calendar {
  /**
   Noon on a 'YYYY-MM-DD', or on the 1st of a 'YYYY-MM'.

   Noon rather than midnight because a DST jump can delete 00:00 outright, and
   nothing that uses this cares about the time of day — only which day it lands
   on. Parsed by splitting rather than with a `DateFormatter`: the string is a
   fixed machine format and a formatter would drag the device's locale into it.
   */
  func noon(on isoDate: String) -> Date? {
    let parts = isoDate.split(separator: "-").compactMap { Int($0) }
    guard parts.count >= 2 else { return nil }
    var components = DateComponents()
    components.year = parts[0]
    components.month = parts[1]
    components.day = parts.count > 2 ? parts[2] : 1
    components.hour = 12
    return date(from: components)
  }
}

extension WidgetSnapshot {
  var timeZone: TimeZone { TimeZone(identifier: zone) ?? .current }

  var calendar: Calendar {
    RidikCalendar.make(timeZone: timeZone, weekStartsOn: month.weekStartsOn)
  }

  /// 'YYYY-MM-DD' for an instant, in the zone the payload was computed in.
  func localDate(_ date: Date) -> String {
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
  }

  /// Whether the strip, the rows and the counts are still about the day in hand.
  func isToday(_ date: Date) -> Bool { localDate(date) == day.date }

  /// Whether the plate is still about the month in hand. Answered separately —
  /// the plate outlives the day by weeks, and saying otherwise throws away the
  /// one Ridik widget that stays honest after the app has not been opened.
  func isCurrentMonth(_ date: Date) -> Bool { localDate(date).hasPrefix(month.month) }

  /**
   Which day of the month it is *now*, in the payload's zone.

   Never `month.today`, which is the day the payload was published. The plate is
   the one face designed to stay honest for weeks without the app being opened,
   and a day number inherited from a publish is stale the moment the day turns:
   open the app on the 5th, leave it alone, and on the 13th the plate hot-fills
   the 5th while the month-level check still passes. Only `month.load` is
   inherited — WIDGETS §3.2.
   */
  func dayOfMonth(_ date: Date) -> Int { calendar.component(.day, from: date) }

  func minuteOfDay(_ date: Date) -> Int {
    let parts = calendar.dateComponents([.hour, .minute], from: date)
    return (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
  }

  /**
   Which cell of the strip an instant falls in.

   Negative before the window opens and past the end after it closes, both of
   which the callers want: everything before `nowCell` has burned down, so a
   negative index burns nothing and an index past the end burns everything.
   */
  func cellIndex(at date: Date) -> Int {
    guard day.cellMinutes > 0 else { return 0 }
    let offset = minuteOfDay(date) - day.startMinute
    return Int(floor(Double(offset) / Double(day.cellMinutes)))
  }

  /// Noon on the day this payload describes, for formatting its date.
  var dayNoon: Date { calendar.noon(on: day.date) ?? publishedDate }

  /// Noon on the 1st of the plate's month, for its weekday offset and name.
  var monthNoon: Date { calendar.noon(on: month.month) ?? publishedDate }

  /**
   How much of the day is still nobody's, from the device's own clock.

   Not `day.freeMinutes`, which is the whole window and would cheerfully offer
   "15h unclaimed" at nine in the evening. Cold cells at or after now, less
   however much of the current one has already gone, floored to the quarter
   hour — rounding up would promise time that is not there.
   */
  func unclaimedMinutes(at date: Date) -> Int {
    let cells = day.cells
    guard !cells.isEmpty else { return 0 }
    let now = cellIndex(at: date)

    var minutes = 0
    for index in cells.indices where index >= now && cells[index] == "0" {
      minutes += day.cellMinutes
    }
    if now >= 0, now < cells.count, cells[now] == "0" {
      let elapsed = minuteOfDay(date) - (day.startMinute + now * day.cellMinutes)
      minutes -= max(0, min(day.cellMinutes, elapsed))
    }
    return max(0, (minutes / 15) * 15)
  }

  /// The strict priority of WIDGETS §3.1: overdue, else due, else habits. Never two.
  var headlineCount: String? {
    if tasks.overdue > 0 { return "\(tasks.overdue) LATE" }
    if tasks.dueToday > 0 { return "\(tasks.dueToday) DUE" }
    if habits.total > 0 { return "\(habits.done)/\(habits.total)" }
    return nil
  }
}

extension Date {
  init(epochMilliseconds: Double) {
    self.init(timeIntervalSince1970: epochMilliseconds / 1000)
  }

  var epochMilliseconds: Double { timeIntervalSince1970 * 1000 }
}

// MARK: - What the face has to say

/**
 A widget wakes with whatever the app left behind, which may be nothing, may be
 from a build that spoke a different dialect, and may be about a day that has
 since ended. Each of those is a different sentence, and none of them is a row
 of zeros — "0 due, 0 overdue, 0/0" is a claim about today that the extension is
 in no position to make.

 A stale snapshot is still handed over whole, because the calendar face draws
 last month's plate from it quite legitimately while refusing to draw yesterday's
 agenda as today's.
 */
/**
 Just enough of a payload to colour a tile that cannot be drawn.

 A `.blank` face has no snapshot, so the notice pane had nothing to read the
 chosen ember from and painted the default — a rust user's "Ridik was updated."
 came up orange, on the one tile whose whole job is to look like the app.

 The ember survives a decode failure because it is one string in a shape that
 does not change: `version` is what decides whether a payload is *drawable*, and
 an unreadable payload can still say which colour it was written in.
 */
private struct EmberProbe: Decodable {
  let ember: String?
}

enum WidgetFace {
  case ready(WidgetSnapshot)
  /// Real data about a day that has ended. Its counts are about that day.
  case stale(WidgetSnapshot)
  case blank(WidgetBlankReason)

  /// The payload behind a face, when there is one at all.
  var snapshot: WidgetSnapshot? {
    switch self {
    case .ready(let snapshot), .stale(let snapshot): return snapshot
    case .blank: return nil
    }
  }

  /**
   The ember to draw this face in, whether or not it has a payload.

   `.blank(.empty)` genuinely has nothing to go on and gets the default, which
   is right: nothing has ever been published, so there is no choice to honour.
   The other two blanks *do* have bytes, and the ember is readable in them even
   when the rest is not.
   */
  var ember: String? {
    switch self {
    case .ready(let snapshot), .stale(let snapshot): return snapshot.ember
    case .blank: return SnapshotStore.lastKnownEmber()
    }
  }

  /**
   The same payload, asked again at a different moment.

   A timeline is dozens of entries and every one of them has to know whether the
   day has turned by the time it is shown — but they are all the same bytes, and
   re-reading and re-decoding the container once per entry is work the extension
   is given a few milliseconds to do.
   */
  func at(_ date: Date) -> WidgetFace {
    guard let snapshot else { return self }
    return snapshot.isToday(date) ? .ready(snapshot) : .stale(snapshot)
  }
}

enum WidgetBlankReason {
  /// Nothing has ever been published — the app has not been opened since install.
  case empty
  /// A snapshot in a shape this build does not know. The app is older or newer.
  case wrongVersion
  /// The shared container could not be opened: the App Group entitlement is missing.
  case unreachable

  var headline: String {
    switch self {
    case .empty: return "Nothing published yet."
    case .wrongVersion: return "Ridik was updated."
    // Not one of the states WIDGETS §4 tabulates, because it is not a state the
    // user can be in on a correctly built install — but it is not the same
    // sentence as either of the other two, and saying so is free.
    case .unreachable: return "Nothing to read."
    }
  }

  var detail: String {
    switch self {
    case .empty: return "Open Ridik once and today lands here."
    case .wrongVersion: return "Open it once to refresh this widget."
    case .unreachable: return "This widget cannot reach Ridik's storage."
    }
  }
}

/// Reads what the app left in the shared container.
enum SnapshotStore {
  /// Must match `WIDGET_SNAPSHOT_VERSION` in `src/services/widgets/snapshot.ts`.
  static let supportedVersion = 4

  /// Twin of `RidikWidgetsModule.defaultsKey`.
  static let defaultsKey = "ridik.widget.snapshot"

  /// Written into this extension's Info.plist by `plugins/withRidikIosWidget.js`.
  private static let appGroupInfoPlistKey = "RidikAppGroup"

  /**
   The ember named by whatever is in the container, however unreadable the rest.

   Decoded separately and leniently: this runs only on a face that has already
   failed, and a second failure here just means the default.
   */
  static func lastKnownEmber() -> String? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: appGroupInfoPlistKey) as? String,
      let defaults = UserDefaults(suiteName: group),
      let json = defaults.string(forKey: defaultsKey),
      let data = json.data(using: .utf8),
      let probe = try? JSONDecoder().decode(EmberProbe.self, from: data)
    else {
      return nil
    }
    return probe.ember
  }

  static func face(at date: Date) -> WidgetFace {
    guard let group = Bundle.main.object(forInfoDictionaryKey: appGroupInfoPlistKey) as? String,
      let defaults = UserDefaults(suiteName: group)
    else {
      return .blank(.unreachable)
    }

    guard let json = defaults.string(forKey: defaultsKey), let data = json.data(using: .utf8) else {
      return .blank(.empty)
    }

    guard let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data) else {
      return .blank(.wrongVersion)
    }

    guard snapshot.version == supportedVersion else {
      return .blank(.wrongVersion)
    }

    return snapshot.isToday(date) ? .ready(snapshot) : .stale(snapshot)
  }
}

// MARK: - The gallery

extension WidgetSnapshot {
  /**
   The face the widget gallery and the placeholder show, before any real data exists.

   Every section is populated, because the gallery draws all five widgets side
   by side and one empty tile among them reads as the broken one. It is built
   around `Date()` rather than written out as a literal for two reasons: a fixed
   morning would already have passed by the time anyone opened the picker, and
   `day.date` and `month.month` have to *be* today and this month or every face
   would preview its own staleness copy.
   */
  static var sample: WidgetSnapshot {
    let now = Date()
    let calendar = RidikCalendar.device
    let midnight = calendar.startOfDay(for: now)

    func at(_ minutes: Double) -> Date { now.addingTimeInterval(minutes * 60) }
    func epoch(_ minutes: Double) -> Double { at(minutes).epochMilliseconds }

    // The strip, built from the same blocks the agenda below lists, so the
    // preview is one coherent day rather than two unrelated drawings.
    let startMinute = 7 * 60
    let cellMinutes = 30
    let cellCount = 32
    var load = Array(repeating: Character("0"), count: cellCount)
    var breaks = Array(repeating: Character("0"), count: cellCount)

    func cell(_ date: Date) -> Int {
      let minute = Int(date.timeIntervalSince(midnight) / 60)
      return Int(floor(Double(minute - startMinute) / Double(cellMinutes)))
    }

    func claim(_ fromMinutes: Double, _ toMinutes: Double) {
      let first = cell(at(fromMinutes))
      // A block ending exactly on a boundary does not own the cell it touches.
      let last = cell(at(toMinutes).addingTimeInterval(-60))
      let lower = max(0, first)
      let upper = min(cellCount - 1, last)
      guard lower <= upper else { return }
      for index in lower...upper { load[index] = "2" }
      if first >= 0, first < cellCount { breaks[first] = "1" }
    }

    claim(-180, -120)
    claim(-90, -60)
    claim(45, 150)
    claim(210, 270)
    claim(330, 390)

    let nextCell = min(cellCount - 1, max(0, cell(at(45))))
    load[nextCell] = "3"

    // A month with a weekly rhythm — busy midweek, clear at the weekend — so
    // the plate previews as a shape rather than as noise.
    let days = calendar.range(of: .day, in: .month, for: now)?.count ?? 31
    let today = calendar.component(.day, from: now)
    let firstOfMonth = calendar.date(
      from: calendar.dateComponents([.year, .month], from: now)
    ) ?? now
    let monthLoad = (0..<days).map { index -> String in
      let weekday = calendar.component(
        .weekday,
        from: calendar.date(byAdding: .day, value: index, to: firstOfMonth) ?? now
      )
      // 1 is Sunday. Weekends stay cold; the working week alternates.
      if weekday == 1 || weekday == 7 { return index % 5 == 0 ? "1" : "0" }
      return index % 3 == 0 ? "2" : "1"
    }.joined()

    /// A rail that reads as a habit rather than as a barcode.
    func history(_ pattern: String, doneToday: Bool) -> String {
      let repeated = String(
        String(repeating: pattern, count: HabitRow.historyDays / pattern.count + 1)
          .prefix(HabitRow.historyDays)
      )
      return String(repeated.dropLast()) + (doneToday ? "1" : "0")
    }

    return WidgetSnapshot(
      version: SnapshotStore.supportedVersion,
      publishedAt: now.epochMilliseconds,
      zone: TimeZone.current.identifier,
      // The gallery previews the default, which is what a fresh install draws
      // and what every screenshot in the store shows.
      ember: RidikEmber.ember.rawValue,
      day: Day(
        date: String(
          format: "%04d-%02d-%02d",
          calendar.component(.year, from: now),
          calendar.component(.month, from: now),
          today
        ),
        startMinute: startMinute,
        cellMinutes: cellMinutes,
        load: String(load),
        breaks: String(breaks),
        nextCell: nextCell,
        freeMinutes: load.filter { $0 == "0" }.count * cellMinutes
      ),
      month: Month(
        month: String(
          format: "%04d-%02d",
          calendar.component(.year, from: now),
          calendar.component(.month, from: now)
        ),
        weekStartsOn: 1,
        load: monthLoad,
        today: today
      ),
      configured: Configured(calendar: true, tasks: true, habits: true, lists: true),
      next: Next(
        title: "Materials lab",
        startsAt: epoch(45),
        leaveAt: epoch(25),
        location: "Workshop 2"
      ),
      tasks: Tasks(
        dueToday: 10,
        overdue: 2,
        ages: [9, 2] + Array(repeating: 0, count: 10),
        rows: [
          TaskRow(title: "Return the drill to Sam", dueAt: epoch(-9 * 24 * 60), overdue: true),
          TaskRow(title: "Email the tutor about the resit", dueAt: epoch(-2 * 24 * 60), overdue: true),
          TaskRow(title: "Submit the parts form", dueAt: epoch(120), overdue: false),
          TaskRow(title: "Order M4 bolts", dueAt: epoch(300), overdue: false),
          TaskRow(title: "Reply to Mira", dueAt: nil, overdue: false),
        ]
      ),
      habits: Habits(
        done: 4,
        total: 6,
        rows: [
          HabitRow(
            name: "Run", doneToday: true, streak: 12, longestStreak: 31,
            history: history("0111111", doneToday: true)
          ),
          HabitRow(
            name: "Read", doneToday: true, streak: 4, longestStreak: 18,
            history: history("1101101", doneToday: true)
          ),
          HabitRow(
            name: "Water", doneToday: true, streak: 1, longestStreak: 9,
            history: history("0011011", doneToday: true)
          ),
          HabitRow(
            name: "Stretch", doneToday: false, streak: 0, longestStreak: 6,
            history: history("0010001", doneToday: false)
          ),
          HabitRow(
            name: "Journal", doneToday: true, streak: 2, longestStreak: 21,
            history: history("1100011", doneToday: true)
          ),
          HabitRow(
            name: "Vitamin", doneToday: false, streak: 0, longestStreak: 3,
            history: history("0000100", doneToday: false)
          ),
        ]
      ),
      agenda: [
        AgendaRow(
          title: "Materials lab",
          startsAt: epoch(45),
          endsAt: epoch(150),
          kind: "class",
          location: "Workshop 2"
        ),
        AgendaRow(
          title: "Call with Mira",
          startsAt: epoch(210),
          endsAt: epoch(270),
          kind: "event",
          location: nil
        ),
        AgendaRow(
          title: "Studio clean-up",
          startsAt: epoch(330),
          endsAt: epoch(390),
          kind: "event",
          location: "Unit 4"
        ),
      ],
      allDay: ["Term starts"],
      list: Checklist(
        name: "Hardware",
        open: 4,
        // Twelve items, six of them published: the preview shows the header
        // doing the one thing `total` is for.
        total: 12,
        rows: [
          ListRow(text: "M4 bolts ×20", done: false),
          ListRow(text: "Threadlock", done: false),
          ListRow(text: "Sanding discs", done: false),
          ListRow(text: "Cable ties", done: false),
          ListRow(text: "Masking tape", done: true),
          ListRow(text: "Wet-and-dry paper", done: true),
        ]
      )
    )
  }
}
