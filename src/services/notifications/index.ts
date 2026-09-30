/**
 * Everything that puts a message in the system tray.
 *
 * One sender: `./local`, which is expo-notifications and owns everything
 * the device schedules for itself — task and commitment reminders, geofence
 * place alerts, focus-timer phases and the ongoing timer. All of it is queued
 * on the device, fires with no network, and is cancelled by id or by
 * `entityId` when the thing it was about changes.
 *
 * There is deliberately no remote-push SDK. Linking one (OneSignal was tried)
 * takes `UNUserNotificationCenter`'s delegate from expo-notifications on iOS
 * before the Expo modules register, which silences in-app banners and the
 * response listener `subscribeToResponses` in `./local` relies on. That is the
 * reason not to add another SDK like it lightly.
 *
 * The daily briefing is the in-app card built by
 * `src/features/home/useDailyBriefing.ts`.
 *
 * This file exists because `notifications.ts` and `notifications/` cannot both
 * live in `src/services`: the file wins resolution and the directory's index is
 * silently dead. Moving the module in here makes that impossible to hit.
 */
export * from './local';
