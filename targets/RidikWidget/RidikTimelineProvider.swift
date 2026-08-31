import Foundation
import WidgetKit

struct RidikEntry: TimelineEntry {
  let date: Date
  let face: WidgetFace
}

/**
 When the extension needs waking, and when it does not.

 A widget cannot poll and its reload budget is finite, so the timeline is built
 out of the moments at which a face changes meaning on its own: the buffer's
 start, the event's start, midnight — and **a quarter-hour stride to the end of
 the published day**.

 The stride is what makes the element honest. Past cells burn down as the day
 goes, and with only event boundaries in the timeline the strip would sit
 unchanged for hours and then jump; Android gets thirty-minute granularity free
 from `updatePeriodMillis` and iOS has to generate its own. Entries are cheap —
 they are dates, and they all share one decoded payload. Only `reloadTimelines`
 spends the budget.

 Nothing here schedules a refresh for new *data*. The app pushes that through
 `RidikWidgetsModule` and calls `reloadAllTimelines()` the moment anything the
 face shows actually changes.
 */
struct RidikTimelineProvider: TimelineProvider {
  /// A day of quarter hours is 96. The ceiling is a guard, not a budget.
  private static let entryCeiling = 128

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
    let calendar = face.snapshot?.calendar ?? RidikCalendar.device

    if case .ready(let snapshot) = face {
      if let next = snapshot.next {
        if let leaveAt = next.leaveDate, leaveAt > now { moments.insert(leaveAt) }
        if next.startDate > now { moments.insert(next.startDate) }
      }
      // The Focus face's clock counts to the end of the current phase, and
      // `Text(_:style: .timer)` counts *past* its date as readily as down to it.
      // Without this entry a finished pomodoro would sit there counting upwards
      // until something else happened to republish.
      if let session = snapshot.focus, let phaseEnd = session.phaseEnd, phaseEnd > now {
        moments.insert(phaseEnd)
      }
      // Every provider in the bundle shares this timeline, so the agenda's own
      // moments belong here too: a row changes from "later" to "now" at its
      // start, and it is the only face that can say so.
      for row in snapshot.agenda where row.startDate > now {
        moments.insert(row.startDate)
      }
      // A task's due time is not in here on purpose. Nothing on the face
      // changes when it passes — the row does not become overdue until the app
      // recomputes the day and publishes again.

      moments.formUnion(stride(from: now, toEndOf: snapshot, calendar))
    }

    // The moment a snapshot about today stops being about today.
    moments.insert(calendar.nextDay(after: now))

    // Each entry re-asks the same decoded payload rather than reading the
    // container again: the one at midnight has to come back `.stale`, which is
    // the whole reason it is in the list.
    let entries = moments
      .sorted()
      .prefix(Self.entryCeiling)
      .map { RidikEntry(date: $0, face: face.at($0)) }

    completion(Timeline(entries: Array(entries), policy: .atEnd))
  }

  /**
   Quarter-hour ticks from now to the end of the day the payload describes.

   Aligned to the quarter hour rather than counted from now, because that is
   where the numbers change: "unclaimed" is quantised to fifteen minutes and a
   cell boundary is always on one. Ticks past the end of the window are left
   out — nothing burns down after the strip has finished.
   */
  private func stride(from now: Date, toEndOf snapshot: WidgetSnapshot, _ calendar: Calendar)
    -> [Date]
  {
    let quarter: TimeInterval = 15 * 60
    let minutes = snapshot.day.startMinute + snapshot.day.cells.count * snapshot.day.cellMinutes
    let end = calendar.startOfDay(for: now).addingTimeInterval(TimeInterval(minutes) * 60)
    guard end > now else { return [] }

    var ticks: [Date] = []
    var tick = Date(
      timeIntervalSince1970: (floor(now.timeIntervalSince1970 / quarter) + 1) * quarter
    )
    while tick < end, ticks.count < Self.entryCeiling {
      ticks.append(tick)
      tick = tick.addingTimeInterval(quarter)
    }
    return ticks
  }
}

extension Calendar {
  /// Midnight at the start of the following day, correct across a DST boundary.
  func nextDay(after date: Date) -> Date {
    let midnight = startOfDay(for: date)
    return self.date(byAdding: .day, value: 1, to: midnight) ?? date.addingTimeInterval(24 * 60 * 60)
  }
}
