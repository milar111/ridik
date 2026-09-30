import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { createLogger } from '@/core/logger';
import { fail, ok, type Result } from '@/core/result';
import { now } from '@/core/clock';

const log = createLogger('notifications');

/**
 * Notification channels.
 *
 * Android forces the user's importance choice per channel, so splitting them is
 * the difference between "mute the noisy timer" and "mute the whole app".
 */
export const CHANNELS = {
  default: 'default',
  reminders: 'reminders',
  timers: 'timers',
  places: 'places',
  briefing: 'briefing',
} as const;

export type ChannelId = (typeof CHANNELS)[keyof typeof CHANNELS];

/**
 * The channels that may break through a Focus mode.
 *
 * `app.config.ts` has always declared the entitlement — `time-sensitive` is one
 * of the few Apple grants that needs no review — and the only place that ever
 * set the level was the focus service's lock-screen fallback. So the two kinds
 * of notification whose *entire value* is arriving at a moment ("leave in ten
 * minutes", "you're at the hardware shop") were delivered at ordinary priority
 * and silenced by the Do Not Disturb somebody turns on precisely because they
 * are busy doing the thing they asked to be reminded about. Android says the
 * same thing through channel importance, which both of these already have.
 *
 * Timers are deliberately not here, and that omission is load-bearing: the
 * running-timer notification is re-posted every phase change on a channel set
 * to LOW with no sound, and the *one* moment it has to interrupt — the lock
 * screen fallback in `services/focus/liveActivity.ts` — sets the level itself.
 * Marking the channel would make a background clock the loudest thing the app
 * sends.
 */
const TIME_SENSITIVE: ReadonlySet<ChannelId> = new Set<ChannelId>([
  CHANNELS.reminders,
  CHANNELS.places,
]);

/** Action categories so a reminder can be dealt with without opening the app. */
export const CATEGORIES = {
  task: 'ridik.task',
  commitment: 'ridik.commitment',
  timer: 'ridik.timer',
} as const;

export type NotificationPayload = {
  /** Deep link opened when the notification is tapped. */
  href?: string;
  kind?: 'task' | 'commitment' | 'geofence' | 'timer' | 'briefing' | 'event';
  entityId?: string;
  [key: string]: unknown;
};

let configured = false;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function configureNotifications(): Promise<void> {
  if (configured) return;
  configured = true;

  if (Platform.OS === 'android') {
    const channels: [ChannelId, Notifications.NotificationChannelInput][] = [
      [
        CHANNELS.default,
        { name: 'General', importance: Notifications.AndroidImportance.DEFAULT },
      ],
      [
        CHANNELS.reminders,
        {
          name: 'Reminders',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 200, 120, 200],
        },
      ],
      [
        CHANNELS.timers,
        {
          name: 'Focus timers',
          importance: Notifications.AndroidImportance.LOW,
          // The running-timer notification is ongoing; it must not buzz on each update.
          sound: null,
          vibrationPattern: null,
        },
      ],
      [
        CHANNELS.places,
        { name: 'Place reminders', importance: Notifications.AndroidImportance.HIGH },
      ],
      [
        CHANNELS.briefing,
        { name: 'Daily briefing', importance: Notifications.AndroidImportance.DEFAULT },
      ],
    ];
    for (const [id, input] of channels) {
      await Notifications.setNotificationChannelAsync(id, input).catch((e) =>
        log.warn(`channel ${id} failed`, e),
      );
    }
  }

  await Promise.all([
    Notifications.setNotificationCategoryAsync(CATEGORIES.task, [
      { identifier: 'complete', buttonTitle: 'Done', options: { opensAppToForeground: false } },
      { identifier: 'snooze', buttonTitle: 'Later', options: { opensAppToForeground: false } },
    ]).catch(() => {}),
    Notifications.setNotificationCategoryAsync(CATEGORIES.commitment, [
      { identifier: 'complete', buttonTitle: 'Done', options: { opensAppToForeground: false } },
    ]).catch(() => {}),
    Notifications.setNotificationCategoryAsync(CATEGORIES.timer, [
      { identifier: 'skip', buttonTitle: 'Skip phase', options: { opensAppToForeground: false } },
      { identifier: 'stop', buttonTitle: 'Stop', options: { opensAppToForeground: false } },
    ]).catch(() => {}),
  ]);
}

/**
 * Checks — and only on request, asks for — notification permission.
 *
 * `prompt` defaults to false so background work (scheduling the morning
 * briefing, re-arming a timer) can never throw the system dialog at a user who
 * has not asked for anything yet. The prompt belongs to a deliberate action:
 * setting a reminder, or the toggle in Settings.
 */
export async function ensurePermission(
  { prompt = false }: { prompt?: boolean } = {},
): Promise<Result<true>> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted || current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
      return ok(true);
    }
    if (!prompt) {
      return fail('permission_denied', 'Ridik has not been allowed to send notifications yet.');
    }
    if (!current.canAskAgain) {
      return fail('permission_denied', 'Notifications are turned off for Ridik in system settings.');
    }
    const asked = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false, provideAppNotificationSettings: true },
    });
    return asked.granted
      ? ok(true)
      : fail('permission_denied', 'Ridik needs notification permission to remind you.');
  } catch (error) {
    return fail('unknown', 'Could not check notification permission.', { cause: error });
  }
}

export type ScheduleInput = {
  title: string;
  body?: string;
  /** UTC epoch ms. A time in the past fires immediately. */
  at: number;
  channel?: ChannelId;
  categoryIdentifier?: string;
  data?: NotificationPayload;
  sound?: boolean;
  /** Set only when the user just asked for this reminder. */
  promptForPermission?: boolean;
};

export async function scheduleAt(input: ScheduleInput): Promise<Result<string>> {
  const permission = await ensurePermission({ prompt: input.promptForPermission ?? false });
  if (!permission.ok) return permission;
  await configureNotifications();

  // Resolved once: the channel decides where Android delivers it *and* whether
  // iOS may interrupt for it, so it is worked out in one place for both the
  // scheduled and the immediate path.
  const channel = input.channel ?? CHANNELS.reminders;

  const content: Notifications.NotificationContentInput = {
    title: input.title,
    body: input.body,
    data: input.data ?? {},
    sound: input.sound === false ? undefined : 'default',
    ...(input.categoryIdentifier ? { categoryIdentifier: input.categoryIdentifier } : {}),
    // iOS only; ignored elsewhere. See `TIME_SENSITIVE`.
    ...(TIME_SENSITIVE.has(channel) ? { interruptionLevel: 'timeSensitive' as const } : {}),
  };

  try {
    if (input.at <= now() + 1000) {
      const id = await Notifications.scheduleNotificationAsync({
        content,
        // A `null` trigger is immediate, and on Android it is also *channelless*
        // — it lands on the default channel whatever the caller asked for. Every
        // geofence crossing goes through `presentNow`, so an arriving reminder
        // was posted to "General" at DEFAULT importance instead of to "Place
        // reminders" at HIGH, and the channel the user could see in system
        // settings governed nothing they ever received.
        trigger: Platform.OS === 'android' ? { channelId: channel } : null,
      });
      return ok(id);
    }
    const id = await Notifications.scheduleNotificationAsync({
      content,
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(input.at),
        ...(Platform.OS === 'android' ? { channelId: channel } : {}),
      },
    });
    return ok(id);
  } catch (error) {
    log.error('schedule failed', error);
    return fail('unknown', 'Could not schedule that reminder.', { cause: error });
  }
}

export async function presentNow(
  input: Omit<ScheduleInput, 'at'>,
): Promise<Result<string>> {
  return scheduleAt({ ...input, at: 0 });
}

export async function cancel(identifier: string): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
}

export async function cancelAllScheduled(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
}

export async function listScheduled(): Promise<Notifications.NotificationRequest[]> {
  return Notifications.getAllScheduledNotificationsAsync().catch(() => []);
}

/** Removes every pending notification whose data carries the given entity id. */
export async function cancelForEntity(entityId: string): Promise<number> {
  const scheduled = await listScheduled();
  const matches = scheduled.filter(
    (r) => (r.content.data as NotificationPayload | undefined)?.entityId === entityId,
  );
  await Promise.all(matches.map((m) => cancel(m.identifier)));
  return matches.length;
}

export type NotificationActionHandler = (event: {
  actionIdentifier: string;
  data: NotificationPayload;
}) => void | Promise<void>;

/**
 * Routes taps and inline actions. Returns an unsubscribe function; the root
 * layout owns the single subscription so handlers cannot pile up on remount.
 */
export function subscribeToResponses(handler: NotificationActionHandler): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((event) => {
    const data = (event.notification.request.content.data ?? {}) as NotificationPayload;
    void Promise.resolve(handler({ actionIdentifier: event.actionIdentifier, data })).catch((e) =>
      log.error('response handler failed', e),
    );
  });
  return () => sub.remove();
}

/** The notification that launched the app, if any. */
export async function getLaunchResponse(): Promise<{
  actionIdentifier: string;
  data: NotificationPayload;
} | null> {
  const response = await Notifications.getLastNotificationResponseAsync().catch(() => null);
  if (!response) return null;
  return {
    actionIdentifier: response.actionIdentifier,
    data: (response.notification.request.content.data ?? {}) as NotificationPayload,
  };
}
