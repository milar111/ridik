/**
 * Strips the entitlements a **free Apple ID cannot be granted**, so the app can
 * be signed with a personal team and put on somebody's phone for seven days.
 *
 * Only active under `RIDIK_FREE_SIGNING=1`; a store build must never lose these.
 *
 * ## Why a stripper and not just fewer plugins
 *
 * `app.config.ts` already drops `withRidikIosWidget` under the same flag, which
 * removes the App Group *and* the WidgetKit target together — correct, because a
 * widget with no shared container is a blank tile rather than a missing one.
 * That is not enough on its own: **`expo-notifications` writes
 * `aps-environment` unconditionally**, from `withNotificationsIOS`, with no
 * prop to turn it off. Push Notifications is a portal-provisioned capability,
 * so a personal team cannot have it, and Xcode fails to provision rather than
 * warning — the build dies at signing with a message about a missing profile
 * that says nothing about which entitlement caused it.
 *
 * So this runs **last** and takes them out of the finished plist. It is the
 * only shape that is robust to a dependency adding one: omitting plugins can
 * only remove what you knew to omit, and the failure mode of missing one is a
 * meetup spent debugging code signing.
 *
 * ## It is listed FIRST in `app.config.ts`, and that is what makes it run last
 *
 * Expo's mods compose in reverse — each `withEntitlementsPlist` wraps the one
 * registered before it, so the plugin listed *last* has its action executed
 * *first*. Registered at the end of the array this was handed an **empty**
 * dict and deleted nothing, and the finished plist looked exactly as it had.
 * Nothing warns; the only way to see it is to log the keys the mod receives,
 * which is how this was found. Do not "tidy" it back to the bottom of the list.
 *
 * ## What each removal costs
 *
 * - `aps-environment` — remote push. The app has none since OneSignal came out
 *   (`src/services/notifications/index.ts`), so this costs nothing at all.
 * - `com.apple.developer.usernotifications.time-sensitive` — reminders still
 *   fire, they just cannot break through a Focus.
 * - `com.apple.security.application-groups` — belt and braces. Dropping the
 *   widget plugin should already have removed it; if some other plugin ever
 *   adds one, the build should still sign rather than fail confusingly.
 */
const { withEntitlementsPlist } = require('expo/config-plugins');

/** Everything the Developer portal provisions and a personal team cannot have. */
const PAID_ONLY = [
  'aps-environment',
  'com.apple.developer.usernotifications.time-sensitive',
  'com.apple.security.application-groups',
];

module.exports = function withRidikFreeSigning(config) {
  return withEntitlementsPlist(config, (mod) => {
    for (const key of PAID_ONLY) delete mod.modResults[key];
    return mod;
  });
};
