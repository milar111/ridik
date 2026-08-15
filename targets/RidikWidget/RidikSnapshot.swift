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
 */
struct WidgetSnapshot: Decodable {
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

    var id: String { name }
  }

  struct ListRow: Decodable, Identifiable {
    let text: String
    let done: Bool

    var id: String { text }
  }

  struct Tasks: Decodable {
    let dueToday: Int
    let overdue: Int
    /// Overdue first, then by due time. Capped by the publisher, not here.
    let rows: [TaskRow]
  }

  struct Habits: Decodable {
    let done: Int
    let total: Int
    /// Not-yet-done first: the face is a prompt, not a scoreboard.
    let rows: [HabitRow]
  }

  struct Checklist: Decodable {
    let name: String
    /// Counted before the rows were capped, so "of 12" stays true.
    let open: Int
    let rows: [ListRow]
  }

  let version: Int
  let publishedAt: Double
  let next: Next?
  let tasks: Tasks
  let habits: Habits
  /// What is left of today, in order. Empty once the day is behind you.
  let agenda: [AgendaRow]
  /// The list worth showing — the first with anything open on it.
  let list: Checklist?

  var publishedDate: Date { Date(epochMilliseconds: publishedAt) }
}

extension Date {
  init(epochMilliseconds: Double) {
    self.init(timeIntervalSince1970: epochMilliseconds / 1000)
  }
}

/**
 What the face has to say at a given moment.

 A widget wakes with whatever the app left behind, which may be nothing, may be
 from a build that spoke a different dialect, and may be about a day that has
 since ended. Each of those is a different sentence, and none of them is a row
 of zeros — "0 due, 0 overdue, 0/0" is a claim about today that the extension is
 in no position to make.
 */
enum WidgetFace {
  case ready(WidgetSnapshot)
  /// Real data, but published on an earlier day, so its counts are about that day.
  case stale(WidgetSnapshot)
  case blank(WidgetBlankReason)
}

enum WidgetBlankReason {
  /// Nothing has ever been published — the app has not been opened since install.
  case empty
  /// A snapshot in a shape this build does not know. The app is older or newer than the widget.
  case wrongVersion
  /// The shared container could not be opened: the App Group entitlement is missing or mismatched.
  case unreachable

  var headline: String {
    switch self {
    case .empty: return "No data yet"
    case .wrongVersion: return "Update Ridik"
    case .unreachable: return "Not set up"
    }
  }

  var detail: String {
    switch self {
    case .empty: return "Open Ridik once and today will appear here."
    case .wrongVersion: return "The app and this widget are different versions."
    case .unreachable: return "This widget cannot reach Ridik's shared storage."
    }
  }
}

/// Reads what the app left in the shared container.
enum SnapshotStore {
  /// Must match `WIDGET_SNAPSHOT_VERSION` in `src/services/widgets/snapshot.ts`.
  static let supportedVersion = 2

  /// Twin of `RidikWidgetsModule.defaultsKey`.
  static let defaultsKey = "ridik.widget.snapshot"

  /// Written into this extension's Info.plist by `plugins/withRidikIosWidget.js`.
  private static let appGroupInfoPlistKey = "RidikAppGroup"

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

    return isCurrent(snapshot, at: date) ? .ready(snapshot) : .stale(snapshot)
  }

  /**
   Whether the snapshot is still about the day being looked at.

   The test is the calendar day rather than an age in hours, because every
   number on the face is day-scoped: "due today" published at 23:50 is a
   statement about yesterday ten minutes later, however fresh it is. A clock
   that has moved backwards past the publish time fails the same test, which is
   the answer we want there too.
   */
  private static func isCurrent(_ snapshot: WidgetSnapshot, at date: Date) -> Bool {
    let published = snapshot.publishedDate
    guard published <= date else { return false }
    return Calendar.current.isDate(published, inSameDayAs: date)
  }
}

extension WidgetSnapshot {
  /**
   The face the widget gallery and the placeholder show, before any real data exists.

   Every section is populated, because the gallery draws all five widgets side by
   side and one empty tile among them reads as the broken one. The times are
   relative to now so the sample never shows a morning that has already passed.
   */
  static var sample: WidgetSnapshot {
    let now = Date()
    func inMinutes(_ minutes: Double) -> Double {
      now.addingTimeInterval(minutes * 60).epochMilliseconds
    }

    return WidgetSnapshot(
      version: SnapshotStore.supportedVersion,
      publishedAt: now.epochMilliseconds,
      next: Next(
        title: "Materials lab",
        startsAt: inMinutes(45),
        leaveAt: inMinutes(25),
        location: "Workshop 2"
      ),
      tasks: Tasks(
        dueToday: 4,
        overdue: 1,
        rows: [
          TaskRow(title: "Send the deposit", dueAt: inMinutes(-180), overdue: true),
          TaskRow(title: "Order M4 bolts", dueAt: inMinutes(120), overdue: false),
          TaskRow(title: "Book the van", dueAt: inMinutes(300), overdue: false),
          TaskRow(title: "Reply to Mira", dueAt: nil, overdue: false),
        ]
      ),
      habits: Habits(
        done: 2,
        total: 3,
        rows: [
          HabitRow(name: "Read", doneToday: false, streak: 12),
          HabitRow(name: "Walk", doneToday: true, streak: 31),
          HabitRow(name: "Stretch", doneToday: true, streak: 4),
        ]
      ),
      agenda: [
        AgendaRow(
          title: "Materials lab",
          startsAt: inMinutes(45),
          endsAt: inMinutes(150),
          kind: "class",
          location: "Workshop 2"
        ),
        AgendaRow(
          title: "Call with Mira",
          startsAt: inMinutes(210),
          endsAt: inMinutes(240),
          kind: "event",
          location: nil
        ),
        AgendaRow(
          title: "Studio clean-up",
          startsAt: inMinutes(330),
          endsAt: inMinutes(390),
          kind: "event",
          location: "Unit 4"
        ),
      ],
      list: Checklist(
        name: "Hardware",
        open: 3,
        rows: [
          ListRow(text: "M4 bolts ×20", done: false),
          ListRow(text: "Threadlock", done: false),
          ListRow(text: "Sanding discs", done: false),
          ListRow(text: "Masking tape", done: true),
        ]
      )
    )
  }
}

extension Date {
  var epochMilliseconds: Double { timeIntervalSince1970 * 1000 }
}
