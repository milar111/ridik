import Foundation
import WidgetKit

struct RidikEntry: TimelineEntry {
  let date: Date
  let face: WidgetFace
}

/**
 When the extension needs waking, and when it does not.

 A widget cannot poll and its reload budget is finite, so the timeline is built
 out of the only moments at which this face changes meaning on its own: the
 buffer's start, the event's start, and midnight, when a snapshot about today
 stops being about today. Everything between those is handled inside the view by
 `Text(_:style:)`, which counts down without the extension running at all.

 Nothing here schedules a refresh for new *data* — the app pushes that through
 `RidikWidgetsModule` and calls `reloadAllTimelines()` the moment anything the
 face shows actually changes.
 */
struct RidikTimelineProvider: TimelineProvider {
  func placeholder(in context: Context) -> RidikEntry {
    RidikEntry(date: Date(), face: .ready(.sample))
  }

  func getSnapshot(in context: Context, completion: @escaping (RidikEntry) -> Void) {
    let now = Date()
    // The gallery shows every widget at once and a strange one there reads as a
    // broken one, so previews always get a plausible day rather than the truth.
    let face: WidgetFace = context.isPreview ? .ready(.sample) : SnapshotStore.face(at: now)
    completion(RidikEntry(date: now, face: face))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<RidikEntry>) -> Void) {
    let now = Date()
    let face = SnapshotStore.face(at: now)

    var moments: Set<Date> = [now]

    if case .ready(let snapshot) = face {
      if let next = snapshot.next {
        if let leaveAt = next.leaveDate, leaveAt > now { moments.insert(leaveAt) }
        if next.startDate > now { moments.insert(next.startDate) }
      }
      // Every provider in the bundle shares this timeline, so the agenda's own
      // moments belong here too: an agenda row changes from "later" to "now" at
      // its start, and it is the only face that can say so.
      for row in snapshot.agenda where row.startDate > now {
        moments.insert(row.startDate)
      }
      // A task's due time is not in here on purpose. Nothing on the face
      // changes when it passes — the row does not become overdue until the app
      // recomputes the day and publishes again.
    }

    let tomorrow = Calendar.current.nextDay(after: now)
    moments.insert(tomorrow)

    // Each entry is re-derived rather than reusing `face`: the one at midnight
    // has to come back `.stale`, which is the whole reason it is in the list.
    let entries = moments.sorted().map { RidikEntry(date: $0, face: SnapshotStore.face(at: $0)) }

    completion(Timeline(entries: entries, policy: .atEnd))
  }
}

extension Calendar {
  /// Midnight at the start of the following day, correct across a DST boundary.
  func nextDay(after date: Date) -> Date {
    let midnight = startOfDay(for: date)
    return self.date(byAdding: .day, value: 1, to: midnight) ?? date.addingTimeInterval(24 * 60 * 60)
  }
}
