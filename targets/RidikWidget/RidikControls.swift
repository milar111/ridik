import AppIntents
import SwiftUI
import WidgetKit

/**
 The microphone, on the Lock Screen and in Control Center (iOS 18+).

 This is the entry point the five-star reviews in this category actually name.
 They do not say "the app is fast to open"; they say *an icon on my lock screen*
 — capture at the instant the thought exists, addressed at the entry point and
 not at the app. A widget still costs a tile of home screen and a look; a control
 costs a swipe from anywhere, including a locked phone.

 Its twin is `RidikSpeakTileService` on Android. Neither ships without the other:
 a quick-capture button that exists on one platform and not the other is the
 "two different products" failure AGENTS.md is about, arriving through the one
 door that is hardest to notice — nobody comparing screenshots would see it.

 Three things worth knowing:

 - **It carries no data.** A control has no timeline and reads no snapshot. That
   is the whole reason it can be added here for nothing: it is a button with a
   URL in it, and `RidikTimelineProvider` is not involved.
 - **`OpenURLIntent` rather than an intent of our own.** The system one already
   does the only thing needed — foreground the app on this URL — and the app
   already knows what to do with `?speak=1` from four other directions. A custom
   `AppIntent` here would be a fifth copy of a decision that is made once, in
   `src/features/voice/speakIntent.ts`.
 - **`@available` rather than a raised deployment target.** `ControlWidget` is
   iOS 18 and this extension ships to 16.4 alongside the app. The bundle adds it
   through `buildLimitedAvailability`, so a phone on 17 gets the five widgets and
   simply never hears about the control.
 */
@available(iOS 18.0, *)
struct RidikSpeakControl: ControlWidget {
  /// Permanent, exactly like a widget's. iOS remembers a placed control by it,
  /// and renaming it takes the button off every Lock Screen it is on.
  static let kind = "RidikSpeakControl"

  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: Self.kind) {
      ControlWidgetButton(action: OpenURLIntent(Route.speak)) {
        Label("Speak", systemImage: "mic.fill")
      }
    }
    .displayName("Speak to Ridik")
    .description("Start talking without opening a screen.")
  }
}
