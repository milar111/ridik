import SwiftUI
import WidgetKit

/**
 The countdown — how long you have got, counted down by the phone.

 The one face that keeps moving when nothing is publishing. `Text(_:style:
 .timer)` is the only genuinely live element WidgetKit gives a widget for zero
 wakeups: it counts itself down with the extension not running at all, where
 anything else would need a timeline entry a minute for the rest of the day.

 ## It counts to the start, not only to the buffer

 Today's tile already carries a live number, and it counts to `leaveAt` and says
 "leave in". That is honest, and it is also silent for most of a calendar: a
 lecture you walk to has no travel buffer, so Today shows it with no live number
 at all. This face counts to whichever moment comes first and **changes the verb
 with it** — "leave in" while there is a buffer to leave for, "starts in" when
 there is not. Carrying the wrong verb over the right number is the one lie a
 live countdown is in a position to tell, so the two travel together.

 ## Started, and past

 `Text(_:style: .timer)` counts *past* its date as readily as down to it, so one
 left running unattended reads a rising number where a falling one was. It is
 only ever mounted while there is time left on it; past the buffer the face falls
 back to the start, and past the start it says the thing is happening, which is a
 sentence rather than a number. The redraws for both moments already exist —
 `RidikTimelineProvider` inserts `leaveDate` and `startDate` for the Today face
 and every face in the bundle shares that timeline.

 ## No large, by decision

 §2 rule 1 — extra height buys more cells before it buys air. The face is one
 number, one title and one place; a large tile would be those three lines with
 two thirds of a tile of ground under them.
 */
struct RidikCountdownView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var colorScheme

  let entry: RidikEntry

  private var small: Bool { family == .systemSmall }

  var body: some View {
    let palette = RidikPalette.of(scheme: colorScheme, ember: entry.face.ember)

    content(palette)
      .ridikTilePadding()
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .ridikGround(palette)
      .widgetURL(Route.today)
  }

  @ViewBuilder
  private func content(_ palette: RidikPalette) -> some View {
    switch entry.face {
    case .ready(let snapshot), .stale(let snapshot):
      face(snapshot, palette: palette)
    case .blank(let reason):
      NoticePane(reason: reason, palette: palette, compact: small)
    }
  }

  @ViewBuilder
  private func face(_ snapshot: WidgetSnapshot, palette: RidikPalette) -> some View {
    let now = entry.date
    // Gated on the day, unlike the week face: "starts in" over a payload from
    // yesterday would be counting down to a lecture that is already over.
    let next = snapshot.isToday(now) ? snapshot.next : nil

    VStack(alignment: .leading, spacing: 0) {
      TileHeader(
        eyebrow: "NEXT",
        trailing: next.map { RidikFormat.clockTime($0.startDate, snapshot.timeZone) },
        palette: palette
      )

      if let next {
        running(next, now: now, zone: snapshot.timeZone, palette: palette)
      } else {
        Spacer(minLength: 6)
        EmptyNote(
          headline: "Nothing else today.",
          sub: "Say \u{201C}remind me to call Ivo at 4\u{201D}.",
          palette: palette,
          compact: small
        )
      }

      Spacer(minLength: 2)
    }
  }

  @ViewBuilder
  private func running(
    _ next: WidgetSnapshot.Next,
    now: Date,
    zone: TimeZone,
    palette: RidikPalette
  ) -> some View {
    // Whichever comes first and is still ahead. The buffer when there is one to
    // leave for, the start otherwise — and the verb travels with the choice.
    let leave = next.leaveDate.flatMap { $0 > now && next.startDate > now ? $0 : nil }
    let target = leave ?? (next.startDate > now ? next.startDate : nil)

    VStack(alignment: .leading, spacing: 0) {
      if let target {
        Text(target, style: .timer)
          // The digits *are* the face, so they are sized like it. Smaller, they
          // were a reading with half a tile of ground under them.
          .font(.system(size: small ? 40 : 52, weight: .medium, design: .monospaced))
          .foregroundStyle(palette.accent)
          .monospacedDigit()
          .lineLimit(1)
          .minimumScaleFactor(0.6)
          .padding(.top, 8)

        Text(leave != nil ? "TO LEAVE" : "TO GO")
          .font(.system(size: 10, weight: .semibold, design: .monospaced))
          .tracking(0.8)
          .foregroundStyle(palette.tertiaryText)
          .lineLimit(1)
      } else {
        // Already begun. Nobody needs to be told how long until a thing they are
        // sitting in, and a countdown at zero is a row of noughts that reads as
        // a fault rather than as an answer.
        Text("happening now")
          .font(.system(size: small ? 20 : 24, weight: .medium))
          .foregroundStyle(palette.accent)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
          .padding(.top, 8)
      }

      Text(next.title)
        .font(.system(size: small ? 15 : 17, weight: .medium))
        .foregroundStyle(palette.text)
        .lineLimit(small ? 2 : 1)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 6)

      if let location = next.location, !location.isEmpty {
        Text(location)
          .font(.system(size: 12, weight: .regular))
          .foregroundStyle(palette.secondaryText)
          .lineLimit(1)
          .padding(.top, 2)
      }
    }
    .accessibilityElement(children: .combine)
    // The live digits read as a bare number to VoiceOver and re-read on every
    // tick. The label states the moment instead, which is the thing that does
    // not change while the tile is open.
    .accessibilityLabel(spoken(next, now: now, zone: zone))
  }

  /// The payload's zone, never the device's: a traveller's tile would otherwise
  /// speak a time that is hours from the one the digits are counting to.
  private func spoken(_ next: WidgetSnapshot.Next, now: Date, zone: TimeZone) -> String {
    let leave = next.leaveDate.flatMap { $0 > now && next.startDate > now ? $0 : nil }
    let place = next.location.map { ", at \($0)" } ?? ""
    guard next.startDate > now else { return "\(next.title), happening now\(place)" }
    if let leave {
      return "\(next.title), leave at \(RidikFormat.spokenTime(leave, zone))\(place)"
    }
    return "\(next.title), starts at \(RidikFormat.spokenTime(next.startDate, zone))\(place)"
  }
}
