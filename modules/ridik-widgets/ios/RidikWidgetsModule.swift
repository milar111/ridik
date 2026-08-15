import ExpoModulesCore
import WidgetKit

/**
 The app's half of the widget transport.

 One method, one direction. The JSON is written verbatim — this side never
 parses it, so `src/services/widgets/snapshot.ts` and the extension's decoder
 are the only two things that need to agree about the shape.

 The App Group identifier is read from the app's own `Info.plist` rather than
 hard-coded here. `plugins/withRidikIosWidget.js` writes the same string into
 three places at prebuild time — this plist, the extension's plist, and both
 entitlements files — because an app group that differs by one character
 between the app and the extension does not fail: it silently hands each
 process its own empty container, and the widget renders as though the user had
 never opened the app.
 */
public class RidikWidgetsModule: Module {
  /// Written by `withRidikIosWidget`. Also read by the extension, from its own plist.
  private static let appGroupInfoPlistKey = "RidikAppGroup"

  /**
   The defaults key both processes use.

   Unlike the group identifier this is a private protocol constant with no
   reason to vary per build, so it is a literal on both sides. Its twin is
   `SnapshotStore.defaultsKey` in `targets/RidikWidget/RidikSnapshot.swift`.
   */
  private static let defaultsKey = "ridik.widget.snapshot"

  public func definition() -> ModuleDefinition {
    Name("RidikWidgets")

    AsyncFunction("setSnapshot") { (json: String) in
      let group = try Self.appGroup()

      guard let defaults = UserDefaults(suiteName: group) else {
        throw AppGroupUnreachableException(group)
      }

      defaults.set(json, forKey: Self.defaultsKey)

      // Cheap when nothing changed and rationed by the OS either way, which is
      // why `publishWidgetSnapshot` refuses to call us for an identical face.
      WidgetCenter.shared.reloadAllTimelines()
    }
  }

  private static func appGroup() throws -> String {
    guard let group = Bundle.main.object(forInfoDictionaryKey: appGroupInfoPlistKey) as? String,
      !group.isEmpty
    else {
      throw MissingAppGroupException(appGroupInfoPlistKey)
    }
    return group
  }
}

/// The plist key is absent, which means the build was made without the config plugin.
internal final class MissingAppGroupException: GenericException<String> {
  override var reason: String {
    "Info.plist has no \(param); the build is missing the withRidikIosWidget config plugin"
  }
}

/// The key is there but the container is not, which means the entitlement is missing.
internal final class AppGroupUnreachableException: GenericException<String> {
  override var reason: String {
    "the app group \(param) is not available to this build; check the app's entitlements"
  }
}
