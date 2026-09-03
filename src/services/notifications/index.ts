/**
 * Everything that puts a message in the system tray.
 *
 * One sender now: `./local`, which is expo-notifications and owns everything
 * the device schedules for itself — task and commitment reminders, geofence
 * place alerts, focus-timer phases and the ongoing timer. All of it is queued
 * on the device, fires with no network, and is cancelled by id or by
 * `entityId` when the thing it was about changes.
 *
 * There used to be a second, `./push`, which was OneSignal delivering exactly
 * one notification — the daily briefing, sent from a dashboard so it arrived
 * whether or not Ridik had been opened. It is gone, and what it cost is worth
 * recording, because it is the reason not to add another SDK like it lightly.
 *
 * **Linking `react-native-onesignal` at all cost expo-notifications its
 * `UNUserNotificationCenter` delegate.** No App ID needed, no JS called: the
 * package swizzled `UIApplication.setDelegate:` from a `+load` and ran
 * `[OneSignal initialize:nil]` from `didFinishLaunchingWithOptions` *before*
 * the Expo modules registered, so expo-notifications found a delegate already
 * in place and backed off rather than overwrite it. Every launch said so —
 *
 *     [expo-notifications] NotificationCenterManager encountered already
 *     present delegate of UNUserNotificationCenter … expo-notifications may
 *     not work properly.
 *
 * — alongside a run of OneSignal's own warnings about being called before its
 * App ID was set, which is its native launch path talking to itself before any
 * of this app's code exists. Scheduling, delivery and cancellation still worked
 * (the OS owns those). What was lost on iOS was `setNotificationHandler`, so a
 * local notification firing while Ridik was open showed no banner, and
 * `addNotificationResponseReceivedListener`, so `subscribeToResponses` in
 * `./local` could not fire. Both work again.
 *
 * The briefing is still there — it is the in-app card built by
 * `src/features/home/useDailyBriefing.ts`. What is gone is a push arriving on a
 * day nobody opened the app.
 *
 * This file exists because `notifications.ts` and `notifications/` cannot both
 * live in `src/services`: the file wins resolution and the directory's index is
 * silently dead. Moving the module in here makes that impossible to hit.
 */
export * from './local';
