import SwiftUI
import WidgetKit

/**
 Calendar — the month as a plate, the day as a strip (WIDGETS §3.2).

 Was Agenda, and the `kind` string is still `RidikAgendaWidget`: both platforms
 identify a placed tile by that string, so changing it would orphan every one
 already on a home screen. Only the name, the description and this view changed.

 Small is the plate alone, and it answers one question — "is the 19th free?" —
 without a single numeral, because 10pt digits in a 17pt cell are unreadable at
 arm's length and the shape of the month is what is being read.

 **This is the one Ridik widget that stays honest a week after the app was last
 opened**, and staleness here is two questions rather than one. The plate is out
 of date only when the month has turned; the strip and the rows are out of date
 as soon as the day has. A face that threw the plate away because the agenda had
 gone stale would be discarding the part that was still true.
 */
struct RidikCalendarView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var colorScheme

  let entry: RidikEntry

  var body: some View {
    let palette = RidikPalette.of(colorScheme)

    content(palette)
      .padding(legacyMargin)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .ridikGround(palette)
      .widgetURL(Route.calendar)
  }

  /// Content margins are iOS 17; before that a widget pads itself or bleeds.
  private var legacyMargin: CGFloat {
    if #available(iOS 17.0, *) { return 0 }
    return 14
  }

  @ViewBuilder
  private func content(_ palette: RidikPalette) -> some View {
    switch entry.face {
    // A stale snapshot is handed over whole. Half of it may still be true, and
    // this face is the only one that can tell which half.
    case .ready(let snapshot), .stale(let snapshot):
      CalendarFace(snapshot: snapshot, now: entry.date, palette: palette, family: family)
    case .blank(let reason):
      // The whole tile — WIDGETS §4, and the only two states that get it. A
      // cold plate of the device's own month under "Ridik was updated." is a
      // calendar drawn from a payload this build could not read, which is the
      // one thing a notice exists to avoid claiming. Every *other* empty state
      // on this face — a clear month, a day with nothing booked, a calendar
      // never set up — still draws its plate and its strip below.
      NoticePane(reason: reason, palette: palette, compact: family == .systemSmall)
    }
  }
}

// MARK: - The face

private struct CalendarFace: View {
  let snapshot: WidgetSnapshot
  let now: Date
  let palette: RidikPalette
  let family: WidgetFamily

  var body: some View {
    switch family {
    case .systemSmall: small
    case .systemLarge: large
    default: medium
    }
  }

  /// Both computed in the payload's zone, never the device's.
  private var dayFresh: Bool { snapshot.isToday(now) }
  private var monthFresh: Bool { snapshot.isCurrentMonth(now) }

  // MARK: Small — the plate

  @ViewBuilder
  private var small: some View {
    VStack(alignment: .leading, spacing: 0) {
      TileHeader(eyebrow: monthLabel, palette: palette)

      plate(rowHeight: nil, numerals: false, todayIsHot: true)
        .padding(.top, 3)

      if let line = plateNote {
        Text(line)
          .font(.system(size: 11, weight: .semibold, design: .rounded))
          .foregroundStyle(palette.text)
          .lineLimit(1)
          .minimumScaleFactor(0.75)
          .padding(.top, 4)
      }
    }
  }

  // MARK: Medium — the day, listed

  @ViewBuilder
  private var medium: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      allDayLine
      element(height: 30)
      Spacer(minLength: 4)
      // An all-day line costs a row. Three rows and a line do not both fit in
      // 131 points, and a clipped fourth row looks like a rendering bug.
      rowsOrNote(rowCap: rowCap(of: 3))
    }
  }

  /// Row capacity, less the all-day line when one is drawn — WIDGETS §3.2, and
  /// true on both medium and large.
  private func rowCap(of rows: Int) -> Int {
    snapshot.allDay.isEmpty || !dayFresh ? rows : rows - 1
  }

  // MARK: Large — both, with no rule between them

  @ViewBuilder
  private var large: some View {
    VStack(alignment: .leading, spacing: 0) {
      header

      // 41 × 25 (WIDGETS §3.2). Seven columns of 41 come out of the width
      // exactly, and the height has to share 321 points with an element, a
      // ruler and three rows — a row of 26 clipped the last agenda row on the
      // shortest large tile, and a row cut through the middle reads as a
      // rendering fault rather than as a full tile.
      plate(rowHeight: 25, numerals: true, todayIsHot: false)
        .padding(.top, 3)

      if let line = plateNote {
        Text(line)
          .font(.system(size: 11, weight: .medium, design: .rounded))
          .foregroundStyle(palette.secondaryText)
          .lineLimit(1)
          .padding(.top, 4)
      }

      // Whitespace, and deliberately no separator: a hairline rule here is what
      // would turn two readings of one day into two panels of a dashboard.
      Spacer(minLength: 8)

      allDayLine
      element(height: 28)
      Spacer(minLength: 4)
      // The all-day line costs a row here exactly as it does on medium: it is
      // about 18 points, the content box is 321, and three rows plus a line
      // overflow it — but only on the days that have one, so a hardcoded 3
      // presents as an intermittent clip through the middle of the last row.
      rowsOrNote(rowCap: rowCap(of: 3))
    }
  }

  // MARK: Pieces

  private var header: some View {
    TileHeader(
      eyebrow: monthLabel,
      trailing: dayFresh ? RidikFormat.dayLabel(snapshot.dayNoon, snapshot.timeZone) : nil,
      palette: palette
    )
  }

  private func plate(rowHeight: CGFloat?, numerals: Bool, todayIsHot: Bool) -> some View {
    MonthPlate(
      month: snapshot.month,
      calendar: snapshot.calendar,
      palette: palette,
      // The device's own clock, in the payload's zone — never `month.today`,
      // which is the day the payload was published and is wrong by however
      // long the app has been closed. See `WidgetSnapshot.dayOfMonth(_:)`.
      today: monthFresh ? snapshot.dayOfMonth(now) : 0,
      rowHeight: rowHeight,
      gap: numerals ? 3 : 2,
      numerals: numerals,
      todayIsHot: todayIsHot
    )
  }

  private func element(height: CGFloat) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      DayElement(
        day: snapshot.day,
        // A day that has ended has burned down completely.
        nowCell: dayFresh ? snapshot.cellIndex(at: now) : snapshot.day.cells.count,
        palette: palette
      )
      .frame(height: height)

      DayAxis(day: snapshot.day, palette: palette)
    }
    .padding(.top, 6)
  }

  /// All-day events are a line, not a list: "flying to Berlin" is exactly what
  /// a glance wants, and a calendar that silently drops them loses whole days.
  @ViewBuilder
  private var allDayLine: some View {
    if dayFresh, let title = snapshot.allDay.first {
      Text(title)
        .font(.system(size: 11, weight: .medium, design: .rounded))
        .foregroundStyle(palette.secondaryText)
        .lineLimit(1)
        .padding(.top, 3)
    }
  }

  @ViewBuilder
  private func rowsOrNote(rowCap: Int) -> some View {
    if !dayFresh {
      EmptyNote(
        headline: "Yesterday's plan.",
        sub: "Open Ridik to bring today's in.",
        palette: palette
      )
    } else if !snapshot.configured.calendar {
      EmptyNote(
        headline: "No events yet.",
        sub: "Say \u{201C}lunch with Ana at one\u{201D}.",
        palette: palette
      )
    } else if snapshot.agenda.isEmpty {
      EmptyNote(
        headline: "Nothing booked today.",
        // Dropped at zero rather than printed: past the end of the window there
        // is no cold cell left to count, and "0m unclaimed" argues with its own
        // headline.
        sub: unclaimedLine,
        palette: palette
      )
    } else {
      let rows = Array(agendaRows.prefix(rowCap))
      VStack(alignment: .leading, spacing: 6) {
        ForEach(rows) { row in
          RowLine(
            row: row,
            palette: palette,
            leadWidth: ridikLeadWidth(for: rows, wide: true)
          )
        }
      }
    }
  }

  private var agendaRows: [RidikRow] {
    snapshot.agenda.map { item in
      // Only the *ending* is dropped by the builder, so a thing already under
      // way is still on this list — and saying so is the point of the widget.
      let running = item.startDate <= now
      return RidikRow(
        id: item.id,
        lead: .time(item.startDate, snapshot.timeZone),
        text: item.title,
        trail: item.location?.nilIfEmpty ?? (item.kind == "class" ? "class" : nil),
        spoken: [
          running ? "Now" : nil,
          item.title,
          running ? nil : "at \(RidikFormat.spokenTime(item.startDate, snapshot.timeZone))",
          item.location?.nilIfEmpty,
        ]
        .compactMap { $0 }
        .joined(separator: ", ")
      )
    }
  }

  private var monthLabel: String {
    RidikFormat.monthName(snapshot.monthNoon, snapshot.timeZone).uppercased()
  }

  /**
   What the plate itself has to say, if anything.

   Its own branch, separate from the day's: an empty month and a month that has
   turned are different sentences, and neither of them is a reason to stop
   drawing the grid.
   */
  private var plateNote: String? {
    if !monthFresh { return "Last month's plate." }
    // Deliberately silent on a calendar that has never been used: on large the
    // face below already says "No events yet.", and the same sentence printed
    // twice on one tile, 120pt apart, reads as a rendering fault. The plate
    // alone — on small, where there is no face below — still says it.
    if !snapshot.configured.calendar { return hasDayFace ? nil : "No events yet." }
    if !snapshot.month.cells.contains(where: { $0 != "0" }) {
      return "\(RidikFormat.monthName(snapshot.monthNoon, snapshot.timeZone)) is clear."
    }
    return nil
  }

  /// Whether the element and its rows are on this tile too. Small is the plate alone.
  private var hasDayFace: Bool { family != .systemSmall }

  /// Nil once the window has run out, rather than "0m".
  private var unclaimedLine: String? {
    let minutes = snapshot.unclaimedMinutes(at: now)
    return minutes > 0 ? "\(RidikFormat.duration(minutes)) unclaimed." : nil
  }
}
