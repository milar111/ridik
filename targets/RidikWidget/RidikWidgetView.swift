import SwiftUI
import WidgetKit

/// Where a tap lands — the same expo-router paths the app navigates to itself.
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

struct RidikWidgetView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var colorScheme

  let entry: RidikEntry

  var body: some View {
    let palette = RidikPalette.of(colorScheme)

    content(palette)
      .padding(legacyMargin)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .ridikGround(palette.ground)
      // A small widget has exactly one tap target, so this is the whole face
      // there. On medium the two `Link`s on the right win inside their own
      // frames and this catches everything else.
      .widgetURL(Route.today)
  }

  /**
   The inset iOS 16 does not apply for us.

   Content margins arrived in iOS 17; before that a widget's content ran to the
   edge of the tile unless it padded itself. Padding on top of the automatic
   margins would double them, so this is zero wherever they exist.
   */
  private var legacyMargin: CGFloat {
    if #available(iOS 17.0, *) { return 0 }
    return 14
  }

  @ViewBuilder
  private func content(_ palette: RidikPalette) -> some View {
    switch entry.face {
    case .ready(let snapshot):
      if family == .systemMedium {
        MediumFace(snapshot: snapshot, now: entry.date, palette: palette)
      } else {
        SmallFace(snapshot: snapshot, now: entry.date, palette: palette)
      }
    case .stale(let snapshot):
      StaleFace(publishedAt: snapshot.publishedDate, palette: palette, wide: family == .systemMedium)
    case .blank(let reason):
      BlankFace(reason: reason, palette: palette, wide: family == .systemMedium)
    }
  }
}

// MARK: - Small

private struct SmallFace: View {
  let snapshot: WidgetSnapshot
  let now: Date
  let palette: RidikPalette

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Eyebrow(text: headline.eyebrow, palette: palette)

      if let next = snapshot.next {
        Text(next.startDate, style: .time)
          .font(.system(size: 26, weight: .medium, design: .monospaced))
          .foregroundStyle(palette.text)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
      }

      Text(headline.title)
        .font(.system(size: 13, weight: .semibold, design: .rounded))
        .foregroundStyle(palette.text)
        .lineLimit(2)
        .minimumScaleFactor(0.85)
        .layoutPriority(1)

      if let leaveAt = leaveAt {
        LeaveLine(leaveAt: leaveAt, now: now, palette: palette, size: 11)
      }

      Spacer(minLength: 2)

      HStack(spacing: 6) {
        Text("\(snapshot.tasks.dueToday) due")
          .foregroundStyle(palette.secondaryText)
        if snapshot.tasks.overdue > 0 {
          Text("\(snapshot.tasks.overdue) late")
            .foregroundStyle(palette.danger)
        }
        Spacer(minLength: 0)
        if snapshot.habits.total > 0 {
          Text("\(snapshot.habits.done)/\(snapshot.habits.total)")
            .foregroundStyle(palette.secondaryText)
        }
      }
      .font(.system(size: 11, weight: .semibold, design: .rounded))
      .lineLimit(1)
    }
  }

  private var headline: (eyebrow: String, title: String) {
    guard let next = snapshot.next else { return ("TODAY", "Nothing left today") }
    return (next.startDate <= now ? "NOW" : "NEXT", next.title)
  }

  /// Suppressed once the thing has started: there is nothing left to leave for.
  private var leaveAt: Date? {
    guard let next = snapshot.next, next.startDate > now else { return nil }
    return next.leaveDate
  }
}

// MARK: - Medium

private struct MediumFace: View {
  let snapshot: WidgetSnapshot
  let now: Date
  let palette: RidikPalette

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      nextColumn
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

      Rectangle()
        .fill(palette.hairline)
        .frame(width: 1)

      VStack(alignment: .leading, spacing: 10) {
        Link(destination: Route.tasks) { tasksBlock }
        Link(destination: Route.habits) { habitsBlock }
        Spacer(minLength: 0)
      }
      .frame(width: 116, alignment: .leading)
    }
  }

  @ViewBuilder
  private var nextColumn: some View {
    VStack(alignment: .leading, spacing: 3) {
      // No live countdown beside this. `Text(_:style: .relative)` renders down
      // to the second — "44 min, 59 secs" — which is both noisier than the
      // absolute time below it and a different answer from the one the app's
      // own home screen gives.
      Eyebrow(text: eyebrow, palette: palette)

      if let next = snapshot.next {
        Text(next.startDate, style: .time)
          .font(.system(size: 30, weight: .medium, design: .monospaced))
          .foregroundStyle(palette.text)
          .lineLimit(1)
          .minimumScaleFactor(0.7)

        Text(next.title)
          .font(.system(size: 15, weight: .semibold, design: .rounded))
          .foregroundStyle(palette.text)
          .lineLimit(2)
          // Without this the stack offers the title and the spacer below it
          // half the slack each, and a two-line title is truncated to one with
          // a third of the column left empty underneath it.
          .layoutPriority(1)

        if let location = next.location, !location.isEmpty {
          Text(location)
            .font(.system(size: 11, weight: .regular, design: .rounded))
            .foregroundStyle(palette.tertiaryText)
            .lineLimit(1)
        }
      } else {
        Text("Nothing left today")
          .font(.system(size: 15, weight: .semibold, design: .rounded))
          .foregroundStyle(palette.text)
          .lineLimit(2)
      }

      Spacer(minLength: 2)

      if let next = snapshot.next, next.startDate > now, let leaveAt = next.leaveDate {
        LeaveLine(leaveAt: leaveAt, now: now, palette: palette, size: 12)
      }
    }
  }

  private var eyebrow: String {
    guard let next = snapshot.next else { return "TODAY" }
    return next.startDate <= now ? "NOW" : "NEXT"
  }

  @ViewBuilder
  private var tasksBlock: some View {
    VStack(alignment: .leading, spacing: 2) {
      Eyebrow(text: "TASKS", palette: palette)
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text("\(snapshot.tasks.dueToday)")
          .font(.system(size: 22, weight: .semibold, design: .rounded))
          .foregroundStyle(palette.text)
        Text("due today")
          .font(.system(size: 11, weight: .medium, design: .rounded))
          .foregroundStyle(palette.secondaryText)
      }
      .lineLimit(1)

      // Absent rather than "0 overdue": nothing overdue is not a number worth
      // spending a line on, and the red only means something if it is rare.
      if snapshot.tasks.overdue > 0 {
        Text("\(snapshot.tasks.overdue) overdue")
          .font(.system(size: 11, weight: .semibold, design: .rounded))
          .foregroundStyle(palette.danger)
          .lineLimit(1)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private var habitsBlock: some View {
    VStack(alignment: .leading, spacing: 3) {
      Eyebrow(text: "HABITS", palette: palette)
      if snapshot.habits.total > 0 {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
          Text("\(snapshot.habits.done)/\(snapshot.habits.total)")
            .font(.system(size: 20, weight: .semibold, design: .monospaced))
            .foregroundStyle(palette.text)
          Text(snapshot.habits.done == snapshot.habits.total ? "all logged" : "logged")
            .font(.system(size: 11, weight: .medium, design: .rounded))
            .foregroundStyle(palette.secondaryText)
            .lineLimit(1)
        }
      } else {
        Text("None tracked")
          .font(.system(size: 11, weight: .medium, design: .rounded))
          .foregroundStyle(palette.tertiaryText)
          .lineLimit(1)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

// MARK: - Nothing to show

struct StaleFace: View {
  let publishedAt: Date
  let palette: RidikPalette
  let wide: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Eyebrow(text: "OUT OF DATE", palette: palette)
      Text("Today's numbers are from an earlier day.")
        .font(.system(size: wide ? 15 : 13, weight: .semibold, design: .rounded))
        .foregroundStyle(palette.text)
        .lineLimit(3)
      Spacer(minLength: 2)
      HStack(spacing: 4) {
        Text("Last updated")
        Text(publishedAt, format: .dateTime.weekday(.abbreviated).hour().minute())
      }
      .font(.system(size: 11, weight: .medium, design: .rounded))
      .foregroundStyle(palette.tertiaryText)
      .lineLimit(1)
      .minimumScaleFactor(0.8)
    }
  }
}

struct BlankFace: View {
  let reason: WidgetBlankReason
  let palette: RidikPalette
  let wide: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Eyebrow(text: "RIDIK", palette: palette)
      Text(reason.headline)
        .font(.system(size: wide ? 17 : 15, weight: .semibold, design: .rounded))
        .foregroundStyle(palette.text)
        .lineLimit(1)
      Text(reason.detail)
        .font(.system(size: 11, weight: .medium, design: .rounded))
        .foregroundStyle(palette.secondaryText)
        .lineLimit(wide ? 2 : 4)
      Spacer(minLength: 0)
    }
  }
}

// MARK: - Pieces

/// The tracked engraving that names a region, from `typography.eyebrow`.
struct Eyebrow: View {
  let text: String
  let palette: RidikPalette

  var body: some View {
    Text(text)
      .font(.system(size: 9, weight: .medium, design: .monospaced))
      .tracking(1.2)
      .foregroundStyle(palette.accent)
      .lineLimit(1)
  }
}

struct LeaveLine: View {
  let leaveAt: Date
  let now: Date
  let palette: RidikPalette
  let size: CGFloat

  var body: some View {
    HStack(spacing: 4) {
      if leaveAt <= now {
        Text("Leave now")
      } else {
        Text("Leave")
        Text(leaveAt, style: .time)
      }
    }
    .font(.system(size: size, weight: .semibold, design: .rounded))
    .foregroundStyle(palette.accent)
    .lineLimit(1)
    .minimumScaleFactor(0.8)
  }
}

