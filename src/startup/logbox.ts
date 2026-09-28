/**
 * The dev-overlay noise this app cannot fix at its source.
 *
 * Two entries, and the bar for a third is the three-part test each of them is
 * argued against below: it is not this app's, it cannot reach a user, and it
 * cannot be fixed from here. A message that fails any one of those is a bug to
 * find, not a line to add — an overlay that is always lit is one nobody reads,
 * which is the whole reason this file exists and also the whole reason it must
 * stay short.
 *
 * ## 1. `expo-notifications`, reading a push registration it never wrote
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
 *  - **It is not this app's registration.** Nothing in `src/` calls
 *    `getExpoPushTokenAsync`, so the value being read is one nothing writes and
 *    nothing reads back. `expo-notifications` is here for *local* notifications
 *    — reminders, place alerts, focus phases — which do not touch this path.
 *    (It used to say "push is OneSignal" as the first half of this reason.
 *    There is no remote push at all now, which makes the point stronger rather
 *    than weaker: nothing in this app has ever wanted an Expo push token.)
 *  - **It cannot happen on a build that ships.** A signed build has the
 *    entitlement and the read succeeds. It is not reachable by a user.
 *  - **It cannot be fixed by adding the entitlement**, because an unsigned
 *    build applies no entitlements at all.
 *
 * So it is unfixable, harmless, and printed on every launch — which is the
 * combination that matters, because an overlay that is always red is one nobody
 * reads. The pattern is the full sentence rather than a package-wide prefix:
 * every *other* thing `expo-notifications` complains about is still shown —
 * which is how the delegate collision `services/notifications/index.ts`
 * documents stayed visible for as long as it existed.
 *
 * ## 2. `onAnimatedValueUpdate`, sent one beat after JS stopped listening
 *
 * A yellow toast on iOS, several at a time, at the moment `boot` resolves and a
 * batch of screens mounts. It is a teardown race two libraries deep and it took
 * a stack trap on `AnimatedValue` to name, so the trail is written down here
 * rather than found again.
 *
 * `react-native-screens` gives **every** native-stack screen an
 * `onTransitionProgress` prop built with `Animated.event(…, { useNativeDriver:
 * true })` — unconditionally, `!isNativeStack ? undefined : Animated.event(…)`,
 * with no prop to turn it off — and `onHeaderHeightChange` the same way. React
 * Native's own `createAnimatedPropsHook` then attaches a **no-op JS listener**
 * (`propValue.addListener(() => {})`) to each of those values, purely so the
 * Fiber tree and the Shadow tree stay in sync. On unmount it removes that
 * listener synchronously, which drops the emitter's count to zero, while
 * `stopListeningToAnimatedNodeValue` is still in flight to the UI thread. Any
 * value the native driver emits in that gap finds no listener, and
 * `RCTEventEmitter.m` logs `Sending \`%@\` with no listeners registered.`
 *
 * The same three-part test:
 *
 *  - **It is not this app's animation.** There is not one core `Animated` import
 *    in `src/` or `app/` — all forty-odd are `react-native-reanimated`, which
 *    has its own pipeline and never touches this module. The value being torn
 *    down belongs to a screen transition `react-native-screens` wired up.
 *  - **It cannot happen on a build that ships.** `RCTLogWarn` and `LogBox` are
 *    both development-only; there is no such string in a release bundle.
 *  - **It cannot be fixed from here.** The `Animated.event` is constructed
 *    inside `react-native-screens`' `Screen` with no opt-out, and the listener
 *    that has to be balanced against it is added by React Native itself. Fixing
 *    it means patching one of the two, and it is still unfixed upstream.
 *
 * What is lost by silencing it is one value update for a transition that has
 * already finished, on a screen that is already unmounting.
 *
 * The pattern names the **event**, not the sentence shape, which is what keeps
 * this honest: `Sending \`onScroll\` with no listeners registered.` — or any
 * other emitter this app does own — still comes through. This is the same rule
 * the entry above follows, and the reason the React warning documented in
 * `AGENTS.md` ("Can't perform a React state update on a component that hasn't
 * mounted yet") is deliberately **not** in this list: that message is generic
 * React text that names no source, so ignoring it would also hide the day our
 * own code causes it.
 *
 * `LogBox` is a development-only overlay and `ignoreLogs` is a no-op in a
 * release bundle, so nothing here changes what ships. It must be imported
 * before anything that pulls in `expo-notifications`, or the message is
 * recorded before the filter exists — which is why it is the first import in
 * `app/_layout.tsx` rather than living in `startup/register.ts`, whose whole
 * job is to be imported late enough that the services it names are ready.
 */
import { LogBox } from 'react-native';

/**
 * Substrings, not prefixes — `LogBox.ignoreLogs` tests a string pattern with
 * `message.includes(pattern)`. Each one is long enough to name its own source:
 * the first keeps the varying `-34018` detail out of the match, the second
 * names the one event whose teardown races, so every other emitter still shows.
 */
export const IGNORED_DEV_LOGS = [
  '[expo-notifications] Error reading persisted server registration info',
  '`onAnimatedValueUpdate` with no listeners registered',
] as const;

LogBox.ignoreLogs([...IGNORED_DEV_LOGS]);
