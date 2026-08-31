import SwiftUI
import WidgetKit

/**
 Focus — the one face with a live clock over something that has a natural end.

 §3.11's countdown is honest and narrow: it counts to a travel buffer, which most
 things on a calendar do not have. A *running session* is the one thing in the app
 that deserves `Text(_:style: .timer)` more, because it ends in forty minutes by
 construction rather than by inference.

 ## The strip is the session, not the day

 Sixteen cells of the booked block — `mid` for focus, `low` for a break — so the
 shape of a pomodoro plan is visible before any of it has been spent. Spent cells
 burn down to the same 38% every other face uses, the current cell is the tile's
 one hot object, and a phase boundary is the same 2pt hairline the day strip
 draws. Nothing new is invented.

 ## Nothing running is a state, and it is the common one

 A timer tile showing a stale `00:00` is worse than a blank one, so the empty
 state hides the clock, draws the strip fully cold and says so in words. That is
 §4 applied to a face whose whole content is a number.

 ## Paused stops the clock rather than freezing a number in it

 The payload sends no moments at all while paused, because a paused session has
 no end — the minutes left are known, when they will finish is not. `Text(_:style:
 .timer)` pointed at a receding moment is wrong every second it is on screen, so
 it is not drawn and the header says PAUSED instead. The strip keeps its marker
 where the pause caught it.

 This is also the face that would most benefit from Live Activities, which
 `src/services/focus/liveActivity.ts` is already a capability-detected adapter
 for. Same extension, so the marginal cost of both is one target rather than two.
 */
struct RidikFocusView: View {
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
    // No staleness branch: a session either is running or is not, and the
    // payload's own answer to that is the only one there is. A "yesterday's
    // plan" notice over a live clock would be a claim about the wrong thing.
    case .ready(let snapshot), .stale(let snapshot):
      if let focus = snapshot.focus {
        running(focus, palette: palette)
      } else {
        idle(palette)
      }
    case .blank(let reason):
      NoticePane(reason: reason, palette: palette, compact: small)
    }
  }

  @ViewBuilder
  private func running(_ focus: WidgetSnapshot.Focus, palette: RidikPalette) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      TileHeader(
        eyebrow: focus.onBreak ? "BREAK" : "FOCUS",
        trailing: focus.paused ? "PAUSED" : nil,
        palette: palette
      )

      if let end = focus.phaseEnd, !focus.paused, end > entry.date {
        Text(end, style: .timer)
          // A step smaller than Countdown's: the session strip is under this
          // one, so the tile has a second object and the digits do not have to
          // carry it alone.
          .font(.system(size: small ? 34 : 44, weight: .medium, design: .monospaced))
          .foregroundStyle(palette.accent)
          .monospacedDigit()
          .lineLimit(1)
          .minimumScaleFactor(0.6)
          .padding(.top, 8)
      } else {
        // A paused clock is not a clock. The word is the honest reading, and it
        // sits where the digits were so the tile does not reflow when it stops.
        Text(focus.paused ? "paused" : "finishing")
          .font(.system(size: small ? 20 : 24, weight: .medium))
          .foregroundStyle(palette.accent)
          .lineLimit(1)
          .padding(.top, 8)
      }

      Text(focus.label)
        .font(.system(size: small ? 13 : 15, weight: .medium))
        .foregroundStyle(palette.text)
        .lineLimit(1)
        .padding(.top, 4)

      SessionStrip(focus: focus, palette: palette)
        .frame(height: small ? 22 : 26)
        .padding(.top, 10)

      Spacer(minLength: 2)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(spoken(focus))
  }

  /// Still a drawing: a fully cold strip at the shape a running session has.
  private func idle(_ palette: RidikPalette) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      TileHeader(eyebrow: "FOCUS", palette: palette)

      SessionStrip(focus: nil, palette: palette)
        .frame(height: small ? 22 : 26)
        .padding(.top, 12)

      Spacer(minLength: 6)

      EmptyNote(
        headline: "No session.",
        sub: "Say \u{201C}focus for 40 minutes\u{201D}.",
        palette: palette,
        compact: small
      )
    }
  }

  private func spoken(_ focus: WidgetSnapshot.Focus) -> String {
    let what = focus.onBreak ? "break" : "focus"
    guard !focus.paused, let end = focus.phaseEnd, end > entry.date else {
      return "\(focus.label), \(what) paused"
    }
    let minutes = Int((end.timeIntervalSince(entry.date) / 60).rounded(.up))
    return "\(focus.label), \(minutes) minutes left in this \(what)"
  }
}

/**
 Sixteen cells of the session, or sixteen cold ones when there is none.

 `nil` draws rather than disappearing, which is §4: the empty state is the same
 drawing with nothing lit, so the tile is recognisable before it has anything to
 say.
 */
private struct SessionStrip: View {
  let focus: WidgetSnapshot.Focus?
  let palette: RidikPalette

  /// Must equal `FOCUS_CELLS` in `snapshot.ts`.
  private static let slots = 16

  var body: some View {
    HStack(alignment: .bottom, spacing: 0) {
      ForEach(0..<Self.slots, id: \.self) { slot in
        let cells = focus?.cells ?? []
        let level: Character = slot == focus?.nowCell ? "3" : (cells.count > slot ? cells[slot] : "0")
        HeatCell(
          level: level,
          palette: palette,
          spent: focus.map { slot < $0.nowCell } ?? false
        )
        .padding(.leading, boundary(at: slot) ? 2 : 0.5)
      }
    }
  }

  /// Never slot 0 — a hairline at the strip's left edge is a gap in the tile's
  /// padding, not a boundary.
  private func boundary(at slot: Int) -> Bool {
    guard slot > 0, let breaks = focus?.breakCells, breaks.count > slot else { return false }
    return breaks[slot] == "1"
  }
}
