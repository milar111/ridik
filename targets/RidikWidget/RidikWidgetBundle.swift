import SwiftUI
import WidgetKit

/**
 The extension's entry point.

 A `WidgetBundle` is what WidgetKit loads instead of an app delegate; the
 target's Info.plist points at `com.apple.widgetkit-extension` and SwiftUI does
 the rest. Nothing in this process can run the app's JavaScript or open its
 database — see `src/services/widgets/snapshot.ts` for why the payload looks the
 way it does.

 Five entries, and each one is a separate row in the widget gallery. They are
 all fed by the same published snapshot, so adding one costs nothing at runtime
 beyond the tiles the user actually places — a widget that is never placed is
 never asked for a timeline.
 */
@main
struct RidikWidgetBundle: WidgetBundle {
  var body: some Widget {
    RidikTodayWidget()
    RidikAgendaWidget()
    RidikTasksWidget()
    RidikHabitsWidget()
    RidikListWidget()
  }
}

struct RidikTodayWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikTodayWidget", provider: RidikTimelineProvider()) { entry in
      RidikWidgetView(entry: entry)
    }
    .configurationDisplayName("Today")
    .description("The next thing, when to leave for it, what is due, and today's habits.")
    // Large would only be the medium face with air around it, and the lock
    // screen families cannot carry four numbers in monochrome.
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct RidikAgendaWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikAgendaWidget", provider: RidikTimelineProvider()) { entry in
      RidikRowsView(entry: entry, section: .agenda)
    }
    .configurationDisplayName("Agenda")
    .description("Everything still to come today, in order.")
    // The one face worth a large tile: a whole afternoon fits, and the rows
    // keep their meaning all the way down the list.
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}

struct RidikTasksWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikTasksWidget", provider: RidikTimelineProvider()) { entry in
      RidikRowsView(entry: entry, section: .tasks)
    }
    .configurationDisplayName("Tasks")
    .description("What is overdue and what is due today, most behind first.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct RidikHabitsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikHabitsWidget", provider: RidikTimelineProvider()) { entry in
      RidikRowsView(entry: entry, section: .habits)
    }
    .configurationDisplayName("Habits")
    .description("Today's habits, the ones still owed first, with their streaks.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct RidikListWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RidikListWidget", provider: RidikTimelineProvider()) { entry in
      RidikRowsView(entry: entry, section: .list)
    }
    .configurationDisplayName("List")
    .description("The checklist you still have something open on.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}
