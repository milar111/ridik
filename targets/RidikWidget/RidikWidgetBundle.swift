import SwiftUI
import WidgetKit

/**
 The extension's entry point.

 A `WidgetBundle` is what WidgetKit loads instead of an app delegate; the
 target's Info.plist points at `com.apple.widgetkit-extension` and SwiftUI does
 the rest. Nothing in this process can run the app's JavaScript or open its
 database — see `src/services/widgets/snapshot.ts` for why the payload looks the
 way it does, and `WIDGETS.md` for what each face draws with it.

 Sixteen entries, and each one is a separate row in the widget gallery. They are
 all fed by the same published snapshot, so adding one costs nothing at runtime
 beyond the tiles the user actually places — a widget that is never placed is
 never asked for a timeline.

 **Every `kind` string here is permanent.** Both platforms identify an
 already-placed tile by it, so renaming one orphans every copy of that widget on
 every home screen. `RidikAgendaWidget` is called Calendar and has been redrawn
 from scratch; its string has not moved.
 */
@main
struct RidikWidgetBundle: WidgetBundle {
  var body: some Widget {
    RidikTodayWidget()
    RidikAgendaWidget()
    RidikTasksWidget()
    RidikHabitsWidget()
    RidikListWidget()
    RidikNowNextWidget()
    RidikRingsWidget()
    RidikPeopleWidget()
    RidikChainWidget()
    RidikCountdownWidget()
    RidikHorizonWidget()
    RidikSundialWidget()
    RidikRouteWidget()
    RidikTermWidget()
    RidikFocusWidget()
    RidikLockWidget()
    controls
  }

  /**
   The Control Center / Lock Screen button, on the systems that have one.

   Split into its own builder because `ControlWidget` is iOS 18 and this
   extension ships to 16.4 with the app. `WidgetBundleBuilder` understands
   `if #available` — it calls `buildLimitedAvailability` — so an older phone gets
   the five widgets and is never told the control exists, which is the only way
   to add it without moving the whole extension's floor two majors.
   */
  @WidgetBundleBuilder
  var controls: some Widget {
    if #available(iOS 18.0, *) {
      RidikSpeakControl()
    }
  }
}

struct RidikTodayWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikTodayWidget", provider: RidikTimelineProvider()) { entry in
      RidikWidgetView(entry: entry)
    }
    .configurationDisplayName("Today")
    .description("The shape of the day, and the next thing on it.")
    // Large would only be the medium face with air around it, and the lock
    // screen families cannot carry a thirty-two cell strip in monochrome.
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct RidikAgendaWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikAgendaWidget", provider: RidikTimelineProvider()) { entry in
      RidikCalendarView(entry: entry)
    }
    .configurationDisplayName("Calendar")
    .description("The month as a plate, the day as a strip. Small is the plate alone.")
    // The one face worth all three sizes: small answers "is the 19th free",
    // large answers that and "what is left of today" without a scroll.
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}

struct RidikTasksWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikTasksWidget", provider: RidikTimelineProvider()) { entry in
      RidikTasksView(entry: entry)
    }
    .configurationDisplayName("Tasks")
    .description("How far behind you are, one cell per open task, oldest first.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct RidikHabitsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikHabitsWidget", provider: RidikTimelineProvider()) { entry in
      RidikHabitsView(entry: entry)
    }
    .configurationDisplayName("Habits")
    .description("Six rails: one week or three, ending on today.")
    // No large. The five-week board fills 321 points with about a third of a
    // tile of rails and the rest ground: six rows cannot grow to meet the
    // height, so the extra buys air rather than cells, which is §2 rule 1
    // exactly. Removed by request after seeing it placed.
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct RidikListWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikListWidget", provider: RidikTimelineProvider()) { entry in
      RidikListView(entry: entry)
    }
    .configurationDisplayName("List")
    .description("The checklist you still have something open on.")
    // Large earns its place here in a way it does not on Today: a shopping list
    // is the one thing on a home screen you want *all* of, and 321 points holds
    // eleven rows where medium holds five. The done rows are rationed at that
    // height — see `rationed(_:done:)` — because a list two-thirds struck
    // through reads as finished when it is not.
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}

/**
 Now / Next / Later.

 A new `kind` string, and permanent from this release like every other one here:
 both platforms identify a placed tile by it. Deliberately *not* the Today kind,
 even though it answers about the same day — reusing that string would repoint
 every Today tile already on a home screen at a different face.
 */
struct RidikNowNextWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikNowNextWidget", provider: RidikTimelineProvider()) { entry in
      RidikNowNextView(entry: entry)
    }
    .configurationDisplayName("Now / Next")
    .description("What you are supposed to be doing, in three words.")
    // No small: three columns in 131 points is 40 points each and truncates
    // every title, and a one-slot small face is Today's readout already.
    .supportedFamilies([.systemMedium, .systemLarge])
  }
}

/**
 The completion rings.

 The one face that draws a proportion, and the only one whose existence needed
 §1 narrowed rather than merely applied — see `RidikRingsView`. All three sizes,
 because it degrades by showing fewer habits rather than smaller ones.
 */
struct RidikRingsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikRingsWidget", provider: RidikTimelineProvider()) { entry in
      RidikRingsView(entry: entry)
    }
    .configurationDisplayName("Rings")
    .description("How much of each habit you have kept, as a share.")
    // Medium alone. No small, because two rings is not a set — it reports on a
    // third of somebody's habits and hides the rest without saying so, which is
    // the one thing a face that is entirely a tally must not do. And no large,
    // because six rings is one row 46 points tall in a 321-point tile: the face
    // has nothing to spend the height on, so it spends it on nothing. Removed
    // by request after seeing it placed.
    .supportedFamilies([.systemMedium])
  }
}

/**
 People — promises owed, oldest first.

 Small and medium, exactly like the Tasks face whose strip it borrows: the face
 is a strip, a reading and a couple of rows, and a large tile would be that with
 air underneath it.
 */
/**
 Focus — the running session, counted down.

 The face `src/services/focus/liveActivity.ts` is the fallback for: same
 extension, so the marginal cost of a Live Activity later is nothing extra here.
 */
struct RidikFocusWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikFocusWidget", provider: RidikTimelineProvider()) { entry in
      RidikFocusView(entry: entry)
    }
    .configurationDisplayName("Focus")
    .description("A running session, counted down, with the plan behind it.")
    // No large. A clock, a label and a sixteen-cell strip, and then air.
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

/**
 The Lock Screen set — three accessory families in one gallery row.

 One `Widget` rather than three, because the Lock Screen's own picker groups by
 slot: the user is choosing what goes *in the circular well*, and three separate
 rows offering one family each would be three identical-looking entries.

 **iOS only, and §7b has been amended to say so.** The both-platforms rule is
 about *controls*; Android has no Lock Screen widget surface at all, and the
 nearest equivalent is a notification, which is a different product decision.
 `RidikLockView` carries the argument in full.
 */
struct RidikLockWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikLockWidget", provider: RidikTimelineProvider()) { entry in
      RidikLockView(entry: entry)
    }
    .configurationDisplayName("Ridik")
    .description("Your day on the Lock Screen: the next thing, and how full today is.")
    .supportedFamilies([.accessoryInline, .accessoryCircular, .accessoryRectangular])
  }
}

/**
 The four expressive faces. `RidikPlotViews.swift` carries all four.

 Three of them — Skyline, Sundial, Route — are *alternative* readings of today
 rather than companions to it, and the descriptions say so: each gives a cell a
 second meaning (a height, a position on a curve, a position on a line), so two
 of them on one screen would disagree about what a cell means. Term is the
 exception, because it counts days rather than measuring them.
 */
struct RidikHorizonWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikHorizonWidget", provider: RidikTimelineProvider()) { entry in
      RidikHorizonView(entry: entry)
    }
    .configurationDisplayName("Skyline")
    .description("An alternative Today: the day as a silhouette, taller where it is busier.")
    // Medium alone. 32 blocks in 131 points is four points each — narrower than
    // the hairline between two of them, so the silhouette stops being a
    // silhouette and becomes a texture. Removed by request after seeing it
    // placed; the mechanic needs the width.
    .supportedFamilies([.systemMedium])
  }
}

struct RidikSundialWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikSundialWidget", provider: RidikTimelineProvider()) { entry in
      RidikSundialView(entry: entry)
    }
    .configurationDisplayName("Sundial")
    .description("An alternative Today: the day as a sun crossing an arc.")
    // Medium alone, for the same reason as Skyline and one more: the disc is
    // sized from the arc's height, so on a small tile it swallows the dots it
    // is supposed to be riding past. Removed by request after seeing it placed.
    .supportedFamilies([.systemMedium])
  }
}

struct RidikRouteWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikRouteWidget", provider: RidikTimelineProvider()) { entry in
      RidikRouteView(entry: entry)
    }
    .configurationDisplayName("Route")
    .description("An alternative Today: the day as a journey, with a puck at now.")
    // Medium alone. The face *is* a line, and 32 segments in 131 points is four
    // points each — narrower than the break between two of them, which is the
    // whole mechanic.
    .supportedFamilies([.systemMedium])
  }
}

struct RidikTermWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikTermWidget", provider: RidikTimelineProvider()) { entry in
      RidikTermView(entry: entry)
    }
    .configurationDisplayName("Term")
    .description("One dot per day: the month on small, the year on medium.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

/**
 The countdown — how long you have got, counted down by the phone.

 The gap this closes is a real one: Today carries a live number only when the
 next thing has a travel buffer, which most things on a calendar do not.
 */
struct RidikCountdownWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikCountdownWidget", provider: RidikTimelineProvider()) { entry in
      RidikCountdownView(entry: entry)
    }
    .configurationDisplayName("Countdown")
    .description("How long until the next thing, counted down live.")
    // No large. §2 rule 1 — the face is one number, one title and one place.
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

/**
 The week — seven days, how full each is, and which one is today.

 The only face that answers a question about *tomorrow*: Today draws the day you
 are standing in and Calendar draws a month you have to find the row in.
 */
struct RidikChainWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikChainWidget", provider: RidikTimelineProvider()) { entry in
      RidikChainView(entry: entry)
    }
    .configurationDisplayName("Week")
    .description("Seven days, how full each one is, and which one is today.")
    // No large. §2 rule 1 — extra height buys more cells before it buys air, and
    // there is no eighth day to buy.
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct RidikPeopleWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikPeopleWidget", provider: RidikTimelineProvider()) { entry in
      RidikPeopleView(entry: entry)
    }
    .configurationDisplayName("People")
    .description("Promises you owe, oldest first.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}
