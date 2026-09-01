import SwiftUI
import WidgetKit

/**
 Now / Next / Later — the one face that answers instead of drawing.

 Every other tile in the family is an *instrument*: it draws a quantity and lets
 you read it. None of them answers the plainest question anyone asks a home
 screen, which is "what am I supposed to be doing?" Three slots do, in three
 words.

 The primitive still appears — one 6pt bar per slot — so the tile belongs to the
 family rather than being a card of text that happens to share a background.
 That bar is deliberately not a strip: a strip would re-answer "how is my day
 shaped", which is Today's question and Today's face.

 ## Everything is classified against this process's clock

 Which row is happening *now* changes every minute while nothing is republished,
 so none of it can come from the payload. `agenda` is "what is left of today";
 this asks the clock which of those rows the moment is inside. A face that let
 the publisher decide would be wrong for up to half an hour at a time and look
 entirely plausible doing it.

 `NOW` stays empty when nothing is running rather than borrowing the next thing.
 "Now: Robotics lab" when Robotics lab starts in two hours is the one lie this
 face is in a position to tell, and the empty copy exists so it does not have to.

 ## One hot per tile, and the strip takes it

 Both sizes draw the day element underneath, and §1.1 allows exactly one hot
 object — so the slots step down to mid / low / cold and the element keeps the
 ember, exactly as §3.2 gives it to the strip rather than to the plate.

 Medium used to stop at the three slots and give `hot` to NOW, which left two
 thirds of the tile as ground under three words. The strip is the one thing that
 can fill it while still saying something.

 ## No small, by decision

 Three columns in 131 points is 40 points each and truncates every title (§2
 rule 2). A one-slot small face would be Today's readout with a different word
 over it, which is a second way to draw something the family already has.
 */
struct RidikNowNextView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var colorScheme

  let entry: RidikEntry

  private var large: Bool { family == .systemLarge }

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
      NoticePane(reason: reason, palette: palette, compact: false)
    }
  }

  @ViewBuilder
  private func face(_ snapshot: WidgetSnapshot, palette: RidikPalette) -> some View {
    let now = Date()
    let fresh = snapshot.isToday(now)
    let slots = Self.slots(in: snapshot, at: now, fresh: fresh)

    VStack(alignment: .leading, spacing: 0) {
      TileHeader(
        // "EARLIER" rather than a weekday the reader is not standing in: a
        // payload from yesterday must not label itself with today's name.
        eyebrow: fresh ? RidikFormat.dayLabel(snapshot.dayNoon, snapshot.timeZone) : "EARLIER",
        trailing: snapshot.tasks.overdue > 0 ? "\(snapshot.tasks.overdue) LATE" : nil,
        emphasis: true,
        palette: palette
      )

      HStack(alignment: .top, spacing: 12) {
        ForEach(Array(slots.enumerated()), id: \.offset) { index, row in
          Slot(
            word: Self.words[index],
            row: row,
            // `large` here is about the *heat*, not the size: the element below
            // is the tile's one hot object at both sizes now, so the slots step
            // down to mid / low / cold at both. §1.1 allows exactly one.
            level: Self.level(at: index, large: true),
            // The payload's zone, never the device's: a traveller's tile is
            // wrong by hours while looking entirely plausible otherwise.
            timeZone: snapshot.timeZone,
            palette: palette
          )
        }
      }
      .padding(.top, 6)

      // §2 rule 1 again, and the large tile is where it was still being broken.
      // Three slots and an element come to 139 of the 321 points a large tile
      // has, so the `Spacer` below was stretching to 182 — more than half the
      // face, empty. It rendered as an unfinished tile rather than as a quiet
      // day, which is the impression the whole family is built to avoid.
      //
      // What fills it is the only thing that can without changing the subject:
      // the rest of today, past the two rows the slots already answered with.
      // The face's question is "what am I supposed to be doing?"; a large tile
      // simply gets more of the answer.
      if large {
        let rest = Self.rest(in: snapshot, at: now, fresh: fresh)
        VStack(alignment: .leading, spacing: 7) {
          if rest.isEmpty {
            // One line rather than nothing. A tile with air under three slots
            // and no explanation reads as a face that failed to draw; a tile
            // that says the day is done reads as an answer.
            Text(slots.contains(where: { $0 != nil })
              ? "Nothing after that."
              : "Nothing left today.")
              .font(.system(size: 12, weight: .medium, design: .rounded))
              .foregroundStyle(palette.tertiaryText)
              .lineLimit(1)
          } else {
            Eyebrow(text: "AFTER THAT", palette: palette)
            ForEach(rest) { row in
              RowLine(
                row: row,
                palette: palette,
                leadWidth: ridikLeadWidth(for: rest, wide: true)
              )
            }
          }
        }
        .padding(.top, 14)
      }

      Spacer(minLength: 4)

      // §2 rule 1 — extra height buys more cells before it buys air, and three
      // words across the top of a medium tile with nothing under them was air.
      // The strip is the one thing that can fill it while still saying
      // something, and it is the same element Today draws from the same payload,
      // so the two tiles agree about the day.
      DayElement(
        day: snapshot.day,
        // Past the end of the strip when the payload is not today's: every
        // cell then reads as spent rather than as a day still ahead of you.
        nowCell: fresh ? snapshot.cellIndex(at: now) : snapshot.day.cells.count,
        palette: palette
      )
      // **24 on medium, and the whole column above had to give up a point or
      // two as well.** A slot is a 9-point word, a bar, a 12-point time and two
      // lines of 13-point title — 74 points — and under a 17-point header with
      // padding, a 12-point spacer and a 34-point element that came to 147 of
      // the 130 a medium tile has. It clipped the *header*, so the face lost the
      // day it was reporting on and the overdue count with it, in silence. The
      // title keeps its two lines: three columns of a medium tile is 92 points
      // each and one line truncates most real event names.
      .frame(height: large ? 40 : 24)
    }
  }

  private static let words = ["NOW", "NEXT", "LATER"]

  /**
   Which heat each slot's bar carries.

   Medium: `hot` on NOW, then mid and low. Large: mid, low, cold — the element
   below is the tile's one hot object.
   */
  private static func level(at index: Int, large: Bool) -> Character {
    // The characters the payload speaks in — '0' cold to '3' hot. Literals
    // rather than a named set because that is what `HeatCell` compares against
    // and what `snapshot.ts` puts on the wire.
    if large { return ["2", "1", "0"][min(index, 2)] }
    return index == 0 ? "3" : ["2", "2", "1"][min(index, 2)]
  }

  /**
   The three rows, filled without ever repeating one.

   Whatever is running takes NOW and the queue behind it fills NEXT and LATER in
   order; when nothing is running the queue starts at NEXT and NOW stays nil.
   Half-open on the end, matching every other comparison in this family: an event
   that ended exactly now is over, not running.

   `static` and taking its clock as a parameter so the classification is a pure
   function — it is the only logic on this face worth being sure of.
   */
  static func slots(
    in snapshot: WidgetSnapshot,
    at now: Date,
    fresh: Bool
  ) -> [WidgetSnapshot.AgendaRow?] {
    guard fresh else { return [nil, nil, nil] }
    let millis = now.timeIntervalSince1970 * 1000
    let running = snapshot.agenda.first { $0.startsAt <= millis && $0.endsAt > millis }
    let ahead = snapshot.agenda.filter { $0.startsAt > millis }
    return [running, ahead.first, ahead.dropFirst().first]
  }

  /**
   Today's remaining rows, past the two the slots already spoke for.

   Large only. `slots` consumes at most two *future* rows — whatever is running
   does not come out of that queue — so the remainder starts at the third one
   ahead, whether or not NOW was filled.

   Capped at six: 321 points less a header, three slots, an eyebrow and a 40pt
   element leaves about 150, and a row and its spacing is 24. Seven would clip
   the element, and this family clips in silence.
   */
  static func rest(
    in snapshot: WidgetSnapshot,
    at now: Date,
    fresh: Bool
  ) -> [RidikRow] {
    guard fresh else { return [] }
    let millis = now.timeIntervalSince1970 * 1000
    return snapshot.agenda
      .filter { $0.startsAt > millis }
      .dropFirst(2)
      .prefix(6)
      .map { item in
        RidikRow(
          id: item.id,
          lead: .time(item.startDate, snapshot.timeZone),
          text: item.title,
          trail: item.location?.nilIfEmpty ?? (item.kind == "class" ? "class" : nil),
          spoken: [
            item.title,
            "at \(RidikFormat.spokenTime(item.startDate, snapshot.timeZone))",
            item.location?.nilIfEmpty,
          ]
          .compactMap { $0 }
          .joined(separator: ", ")
        )
      }
  }
}

/**
 One column: the word, the bar, the time, the title.

 The title wraps to two lines rather than truncating. It is the answer the whole
 face exists to give, and "Robotics l…" is a worse answer than a second line.
 */
private struct Slot: View {
  let word: String
  let row: WidgetSnapshot.AgendaRow?
  let level: Character
  let timeZone: TimeZone
  let palette: RidikPalette

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(word)
        .font(.system(size: 9, weight: .semibold, design: .monospaced))
        .tracking(1.1)
        .foregroundStyle(palette.secondaryText)
        .lineLimit(1)

      HeatCell(level: level, palette: palette)
        .frame(height: 5)

      Text(row.map { RidikFormat.clockTime($0.startDate, timeZone) } ?? "—")
        .font(.system(size: 12, weight: .medium, design: .monospaced))
        .foregroundStyle(palette.accent)
        .lineLimit(1)
        .padding(.top, 2)

      Text(title)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(row == nil ? palette.secondaryText : palette.text)
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(spoken)
  }

  /// An empty slot is a real answer, not a blank column that reads as a failure.
  private var title: String {
    guard row == nil else { return row!.title }
    return word == "NOW" ? "nothing running" : "nothing"
  }

  private var spoken: String {
    guard let row else {
      return word == "NOW" ? "Now, nothing running" : "\(word.capitalized), nothing scheduled"
    }
    return "\(word.capitalized), \(row.title), at \(RidikFormat.spokenTime(row.startDate, timeZone))"
  }
}
