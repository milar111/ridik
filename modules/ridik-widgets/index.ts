/**
 * The bridge the home-screen widgets read through.
 *
 * A widget runs in its own process, wakes for a few milliseconds and cannot
 * touch this app's JavaScript or its SQLite file. So the contract is one
 * direction and one method: the app hands over a JSON snapshot, the native side
 * writes it somewhere both processes can see, and asks the OS to redraw.
 *
 * Shared storage differs per platform and that difference stays here:
 *   iOS      an App Group's UserDefaults, then WidgetCenter.reloadAllTimelines
 *   Android  SharedPreferences, then a broadcast to the AppWidgetProvider
 *
 * `src/services/widgets/publish.ts` loads this optionally — a build without the
 * native side compiled in gets null and no-ops, which is what every test run
 * and every Expo Go session does.
 */
import { requireNativeModule } from 'expo-modules-core';

declare class RidikWidgetsModule {
  /**
   * Hands the widget its new face. The payload is `WidgetSnapshot` as JSON;
   * the native side never parses it, so the shape is owned entirely by
   * `src/services/widgets/snapshot.ts` and the widget's own decoder.
   */
  setSnapshot(json: string): Promise<void>;
}

export default requireNativeModule<RidikWidgetsModule>('RidikWidgets');
