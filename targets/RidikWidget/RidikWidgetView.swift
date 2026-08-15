import SwiftUI
import WidgetKit

/**
 Today — the element, the ruler, and the next thing on it (WIDGETS §3.1).

 The strip is the face. Everything else on the tile is a caption for it: the
 header names the day and spends its one number on whatever is most behind, and
 the two lines underneath say what the hot cell is. That order is deliberate —
 the shape of the day is legible from across a room, and the words are for once
 you have already looked.
 */
struct RidikWidgetView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var colorScheme

  let entry: RidikEntry

  var body: some View {
    let palette = RidikPalette.of(scheme: colorScheme, ember: entry.face.snapshot?.ember)

    content(palette)
      .padding(legacyMargin)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .ridikGround(palette)
      // A widget gets one tap target per tile and nothing finer, so this is the
      // whole face at both sizes.
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
    let small = family == .systemSmall

    switch entry.face {
    case .ready(let snapshot):
      TodayFace(snapshot: snapshot, now: entry.date, palette: palette, small: small, stale: false)
    case .stale(let snapshot):
      TodayFace(snapshot: snapshot, now: entry.date, palette: palette, small: small, stale: true)
    case .blank(let reason):
      // The whole tile, and only here. A cold strip under "Nothing published
      // yet." was drawing a day the extension has never been told anything
      // about — WIDGETS §4 keeps the notice pane for exactly these two states
      // and hands every other empty state its graphic. Android has always
      // drawn this one as a notice; iOS was the platform out of step.
      NoticePane(reason: reason, palette: palette, compact: small)
    }
  }
}

// MARK: - The face

private struct TodayFace: View {
  let snapshot: WidgetSnapshot
  let now: Date
  let palette: RidikPalette
  let small: Bool
  /// The strip is a day that has ended: every cell of it is behind you.
  let stale: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      TileHeader(
        eyebrow: "TODAY",
        detail: small ? nil : RidikFormat.dayLabel(snapshot.dayNoon, snapshot.timeZone),
        // Suppressed on a stale face: every one of those counts is a claim
        // about a day that has already ended.
        trailing: stale ? nil : snapshot.headlineCount,
        palette: palette
      )

      DayElement(
        day: snapshot.day,
        nowCell: nowCell,
        palette: palette,
        bucket: small ? 4 : 1
      )
      .frame(height: small ? 26 : 34)
      .padding(.top, 6)

      // The same bucket the element was drawn with: the ruler lays its labels
      // out on the element's cells, so a mismatch would point them at nothing.
      DayAxis(day: snapshot.day, palette: palette, bucket: small ? 4 : 1)
        .padding(.top, 3)

      Spacer(minLength: 4)

      readout
    }
  }

  /// A day that has ended has burned down completely; that is the whole message.
  private var nowCell: Int {
    stale ? snapshot.day.cells.count : snapshot.cellIndex(at: now)
  }

  @ViewBuilder
  private var readout: some View {
    if stale {
      EmptyNote(
        headline: "Yesterday's plan.",
        sub: "Open Ridik to bring today's in.",
        palette: palette,
        compact: small
      )
    } else if let note = note {
      EmptyNote(headline: note.headline, sub: note.sub, palette: palette, compact: small)
    } else if let next = snapshot.next {
      VStack(alignment: .leading, spacing: 1) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          // Formatted in the payload's zone. `style: .time` renders in the
          // device's, which would put "08:00" above a strip whose hot cell is
          // at the 15:00 mark for anyone reading this abroad.
          Text(RidikFormat.clockTime(next.startDate, snapshot.timeZone))
            .font(.system(size: small ? 30 : 26, weight: .medium, design: .monospaced))
            .foregroundStyle(palette.text)
            .lineLimit(1)
            .minimumScaleFactor(0.7)

          if !small {
            Text(next.title)
              .font(.system(size: 15, weight: .semibold, design: .rounded))
              .foregroundStyle(palette.text)
              .lineLimit(1)
          }
        }

        if small {
          Text(next.title)
            .font(.system(size: 12, weight: .semibold, design: .rounded))
            .foregroundStyle(palette.text)
            .lineLimit(1)
        }

        subline(next)
      }
    }
  }

  @ViewBuilder
  private func subline(_ next: WidgetSnapshot.Next) -> some View {
    let leave = next.startDate > now ? next.leaveDate : nil
    let location = next.location?.nilIfEmpty

    HStack(spacing: 4) {
      if let leave {
        if leave <= now {
          Text("leave now")
            .foregroundStyle(palette.accent)
        } else {
          // The only genuinely live element WidgetKit gives for zero wakeups:
          // it counts itself down with the extension not running at all.
          Text("leave in")
            .foregroundStyle(palette.accent)
          Text(leave, style: .timer)
            .foregroundStyle(palette.accent)
            .monospacedDigit()
            .fixedSize()
        }
      }
      if let location {
        if leave != nil {
          Text("·").foregroundStyle(palette.tertiaryText)
        }
        Text(location)
          .foregroundStyle(palette.tertiaryText)
          .lineLimit(1)
      }
    }
    .font(.system(size: small ? 11 : 12, weight: .medium, design: .rounded))
    .lineLimit(1)
  }

  /**
   What the face says when there is nothing next (WIDGETS §4).

   `configured` is what separates "you have done everything" from "you have
   never set this up". Without it those two render identically, which is most of
   the reason an untouched install looks broken rather than empty.
   */
  private var note: (headline: String, sub: String?)? {
    let configured = snapshot.configured
    if !configured.calendar, !configured.tasks, !configured.habits {
      return ("Nothing in here yet.", "Hold the mic and say what's on today.")
    }
    guard snapshot.next == nil else { return nil }

    // Not `day.freeMinutes`: that is the whole window, and would still be
    // offering fifteen hours at nine in the evening.
    //
    // Dropped entirely at zero rather than printed. Past the end of the window
    // there is no cold cell left to count, and "Winding down. / 0m left." is a
    // tile arguing with itself — the headline already says the day is over.
    let minutes = snapshot.unclaimedMinutes(at: now)
    let unclaimed = minutes > 0 ? RidikFormat.duration(minutes) : nil
    if snapshot.minuteOfDay(now) < 17 * 60 {
      return ("The day is yours.", unclaimed.map { "\($0) unclaimed." })
    }
    return ("Winding down.", unclaimed.map { "\($0) left." })
  }
}
