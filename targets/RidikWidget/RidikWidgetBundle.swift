import SwiftUI
import WidgetKit

/**
 The extension's entry point.

 A `WidgetBundle` is what WidgetKit loads instead of an app delegate; the
 target's Info.plist points at `com.apple.widgetkit-extension` and SwiftUI does
 the rest. Nothing in this process can run the app's JavaScript or open its
 database — see `src/services/widgets/snapshot.ts` for why the payload looks the
 way it does.
 */
@main
struct RidikWidgetBundle: WidgetBundle {
  var body: some Widget {
    RidikTodayWidget()
  }
}

struct RidikTodayWidget: Widget {
  private let kind = "RidikTodayWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: RidikTimelineProvider()) { entry in
      RidikWidgetView(entry: entry)
    }
    .configurationDisplayName("Today")
    .description("The next thing, when to leave for it, what is due, and today's habits.")
    // Large would only be the medium face with air around it, and the lock
    // screen families cannot carry four numbers in monochrome.
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}
