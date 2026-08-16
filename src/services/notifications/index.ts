/**
 * Everything that puts a message in the system tray, and who owns which one.
 *
 * There are two senders, and confusing them is how an app ends up delivering
 * everything twice. The rule is a line, not a judgement call:
 *
 *   `./local`  — expo-notifications. **Everything the device schedules for
 *                itself**: task and commitment reminders, geofence place
 *                alerts, focus-timer phases and the ongoing timer. All of it is
 *                queued on the device, fires with no network, and is cancelled
 *                by id or by `entityId` when the thing it was about changes.
 *
 *   `./push`   — OneSignal. **Exactly one notification: the daily briefing**,
 *                sent from the OneSignal dashboard so it arrives whether or not
 *                Ridik has been opened. Nothing else goes out over push, and
 *                the local side has scheduled no briefing since it became an
 *                in-app card (see `src/features/home/useDailyBriefing.ts`) — so
 *                the two can never both deliver the same thing.
 *
 * `./push` is deliberately *not* re-exported here. It reaches for
 * `react-native-onesignal`, and this barrel is imported by the voice pipeline,
 * the geofence service and the focus runtime, three modules that must stay
 * loadable in the plain-Node test project. Import it as
 * `@/services/notifications/push` from the one place that starts it.
 *
 * This file exists because `notifications.ts` and `notifications/` cannot both
 * live in `src/services`: the file wins resolution and the directory's index is
 * silently dead. Moving the module in here makes that impossible to hit.
 *
 * ---
 *
 * **Known conflict on iOS, and it is not caused by anything in this directory.**
 * Linking `react-native-onesignal` at all — no App ID needed, no JS called —
 * costs expo-notifications its `UNUserNotificationCenter` delegate. The package
 * swizzles `UIApplication.setDelegate:` from a `+load`
 * (`ios/RCTOneSignal/UIApplication+RCTOnesignal.m`) and runs
 * `[OneSignal initialize:nil]` from `didFinishLaunchingWithOptions` *before*
 * the Expo modules register, so expo-notifications finds a delegate already in
 * place and backs off rather than overwrite it. Every launch says so:
 *
 *     [expo-notifications] NotificationCenterManager encountered already
 *     present delegate of UNUserNotificationCenter … expo-notifications may
 *     not work properly.
 *
 * What still works: scheduling, delivery, cancellation — the OS owns those.
 * What is lost on iOS: `setNotificationHandler` (so a local notification that
 * fires while Ridik is open shows no banner) and `addNotificationResponseReceivedListener`
 * (so `subscribeToResponses` in `./local` cannot fire — nothing subscribes to
 * it today, but the focus timer's inline actions were meant to).
 *
 * The fix is native and belongs with whoever owns the config plugins: reassign
 * `UNUserNotificationCenter.current().delegate` to expo-notifications'
 * `NotificationCenterManager` after launch. OneSignal swizzles
 * `setDelegate:` too and chains to whatever is set after it, so both end up
 * working — it is only the ordering that breaks this.
 */
export * from './local';
