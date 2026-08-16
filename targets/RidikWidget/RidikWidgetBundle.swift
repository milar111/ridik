import SwiftUI
import WidgetKit

/**
 The extension's entry point.

 A `WidgetBundle` is what WidgetKit loads instead of an app delegate; the
 target's Info.plist points at `com.apple.widgetkit-extension` and SwiftUI does
 the rest. Nothing in this process can run the app's JavaScript or open its
 database — see `src/services/widgets/snapshot.ts` for why the payload looks the
 way it does, and `WIDGETS.md` for what each face draws with it.

 Five entries, and each one is a separate row in the widget gallery. They are
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
    .description("Six rails: one week, three weeks or five, ending on today.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}

struct RidikListWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikListWidget", provider: RidikTimelineProvider()) { entry in
      RidikListView(entry: entry)
    }
    .configurationDisplayName("List")
    .description("The checklist you still have something open on.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}
