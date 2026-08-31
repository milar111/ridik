import SwiftUI
import WidgetKit

/**
 People — the debt primitive, pointed at promises.

 Tasks' age axis transfers unchanged: one cell per outstanding promise, oldest
 left, the single oldest hot. Nothing new is invented, which is why this is the
 cheapest face in the family to have added.

 The reason it earns a tile is that it is the only face whose data nothing else
 in the app surfaces at a glance. **A promise with no due date can never become
 overdue** — so it never reaches Tasks, never reaches "due today", and never
 reaches a briefing. It simply gets older. That is the app's quietest failure
 mode, and a strip whose oldest cell is the hot one is the whole fix.

 ## Not gated on the day, and that is the one departure from Tasks

 Tasks is a tally of a particular day: a payload from a day that has ended keeps
 its shape and loses its counts. A promise made three weeks ago is exactly as
 owed this morning as it was last night, so "Yesterday's plan." over this face
 would be a claim about the wrong thing — the same reasoning that keeps the
 checklist ungated.

 The ages are days since the promise was **made**, not days past due. For most of
 these rows there is no due date to be past, which is the point.
 */
struct RidikPeopleView: View {
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
      .widgetURL(Route.people)
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
    let people = snapshot.people
    let rows = Array(people.rows.prefix(small ? 2 : 3))

    VStack(alignment: .leading, spacing: 0) {
      TileHeader(
        eyebrow: "PEOPLE",
        trailing: people.owed > 0 ? "\(people.owed) OWED" : nil,
        palette: palette
      )

      DebtStrip(ages: people.ages, cap: small ? 12 : 24, palette: palette)
        .frame(height: small ? 20 : 24)
        .padding(.top, 6)

      // The strip is capped at 12 or 24; this carries the true count, or a tile
      // owing thirty things would quietly claim twenty-four. Set as a reading
      // rather than two captions at opposite ends — the same shape Tasks uses,
      // and the same §1 rule about evenly spaced stat pills that forced it.
      HeroCount(
        value: "\(people.owed)",
        caption: people.owed == 1 ? "promise" : "promises",
        // Dropped on small, where a reading and a footnote do not both fit in
        // 119 points. Nothing is lost: the first row's own lead reads `11d`,
        // and it is the same promise.
        trailing: !small && (people.ages.first ?? 0) > 0 ? "oldest \(people.ages[0])d" : nil,
        palette: palette,
        size: small ? 26 : 18
      )
      .padding(.top, small ? 6 : 4)

      Spacer(minLength: small ? 6 : 2)

      if people.owed == 0 {
        EmptyNote(
          headline: "Nothing owed.",
          sub: "Say \u{201C}I promised Ana the reading list\u{201D}.",
          palette: palette,
          compact: small
        )
      } else {
        VStack(alignment: .leading, spacing: small ? 8 : 6) {
          ForEach(Array(rows.enumerated()), id: \.offset) { offset, row in
            RowLine(
              row: RidikRow(
                id: row.id(at: offset),
                // The age in the lead column, where Tasks puts a time: it is the
                // number the cell above was drawn from, so row and strip agree.
                lead: .text("\(row.age)d"),
                text: row.text,
                trail: row.name,
                spent: false,
                spoken: "\(row.text), to \(row.name), \(row.age) days ago"
              ),
              palette: palette,
              wide: !small,
              leadWidth: 30
            )
          }
        }
      }
    }
  }
}
