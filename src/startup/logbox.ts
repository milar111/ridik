/**
 * The one piece of dev-overlay noise this app cannot fix at its source.
 *
 * `expo-notifications` runs `DevicePushTokenAutoRegistration.fx` as a side
 * effect of being imported: at module evaluation it reads its own *Expo push*
 * server registration out of the keychain, and `console.error`s if that read
 * rejects. On the iOS simulator it always rejects. These debug builds are made
 * with `CODE_SIGNING_ALLOWED=NO`, entitlements are embedded during signing, so
 * an unsigned binary has none and every keychain access group is unavailable —
 * `errSecMissingEntitlement`, `-34018`.
 *
 * Three separate reasons it is inert here, and it needs all three to be worth
 * silencing rather than investigating:
 *
 *  - **It is not this app's registration.** Push is OneSignal
 *    (`services/notifications/push.ts`). Nothing in `src/` calls
 *    `getExpoPushTokenAsync`, so the value being read is one nothing writes and
 *    nothing reads back. `expo-notifications` is here for *local* notifications
 *    — the briefing and reminders — which do not touch this path.
 *  - **It cannot happen on a build that ships.** A signed build has the
 *    entitlement and the read succeeds. It is not reachable by a user.
 *  - **It cannot be fixed by adding the entitlement**, because an unsigned
 *    build applies no entitlements at all.
 *
 * So it is unfixable, harmless, and printed on every launch — which is the
 * combination that matters, because an overlay that is always red is one nobody
 * reads. The pattern is the full sentence rather than a package-wide prefix:
 * every *other* thing `expo-notifications` complains about is still shown,
 * including the delegate collision `services/notifications/index.ts` documents.
 *
 * `LogBox` is a development-only overlay and `ignoreLogs` is a no-op in a
 * release bundle, so nothing here changes what ships. It must be imported
 * before anything that pulls in `expo-notifications`, or the message is
 * recorded before the filter exists — which is why it is the first import in
 * `app/_layout.tsx` rather than living in `startup/register.ts`, whose whole
 * job is to be imported late enough that the services it names are ready.
 */
import { LogBox } from 'react-native';

/** Matched as a prefix of the message, so the `-34018` detail still varies. */
export const IGNORED_DEV_LOGS = [
  '[expo-notifications] Error reading persisted server registration info',
] as const;

LogBox.ignoreLogs([...IGNORED_DEV_LOGS]);
