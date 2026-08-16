/**
 * Remote push, through OneSignal. One notification: the daily briefing.
 *
 * Why a server sends it at all, when the app can already schedule its own
 * notifications: the briefing is the one message worth delivering to somebody
 * who has *not* opened Ridik. Everything local — reminders, place alerts, timer
 * phases — is about something the user set up, and a device can queue those
 * perfectly well. A morning briefing is the opposite: its whole job is to be
 * the reason the app gets opened, so it cannot be conditional on the app having
 * been opened. See `./index.ts` for the ownership line in full.
 *
 * Loaded optionally, the same shape as `services/billing/revenuecat.ts` and
 * `services/focus/liveActivity.ts`: `react-native-onesignal` is resolved at
 * call time, and with no App ID configured every function here becomes a
 * logged no-op. A build with no push project is not a broken build; it is a
 * build where the briefing is the in-app card and nothing else, exactly as it
 * was before this file existed.
 *
 * To make it live:
 *   1. Create a OneSignal app; add both platforms (bundle id and package are
 *      both `ai.raisen.ridik`), upload the APNs .p8 and the Firebase service
 *      account JSON.
 *   2. `EXPO_PUBLIC_ONESIGNAL_APP_ID=<app id>` at build time — `extra` is baked
 *      into the binary, so a Metro restart will not pick up a change.
 *   3. In the dashboard, schedule a recurring push and write its message as a
 *      Liquid template over the tags this file publishes:
 *
 *        Title:  Your day
 *        Body:   {{ briefing_line | default: "Here's your day." }}
 *        Data:   { "href": "/briefing" }
 *        Android category: existing_android_channel_id = "briefing"
 *
 *      Send it at each user's own local time, and segment on
 *      `briefing_quiet != "1"` so nobody is woken up to be told they have
 *      nothing on. `briefing_streak_risk = "1"` is the one worth its own send.
 *
 * Nothing above is compiled in. The schedule, the wording, the segments and
 * which OneSignal project is talked to are all dashboard- or environment-owned,
 * which is the standard DEPLOY.md §0 holds the rest of this app to.
 */
import Constants from 'expo-constants';
import { AppState, type AppStateStatus } from 'react-native';
import { router } from 'expo-router';

import { now } from '@/core/clock';
import { createLogger } from '@/core/logger';
import { fail, ok, toAppError, type Result } from '@/core/result';
import { registerBootstrapStep } from '@/startup/bootstrap';

import {
  BRIEFING_HREF,
  BRIEFING_TAG_KEYS,
  briefingPushTags,
  dueForRefresh,
  pushAppId,
  resolvePushHref,
  shouldOptIn,
  tagsChanged,
  type BriefingTags,
} from './briefingPush';
import { configureNotifications, ensurePermission } from './local';

const log = createLogger('push');

/* --------------------------------------------------------------- config -- */

/**
 * Read per call rather than cached: `Constants.expoConfig` is not populated at
 * module-evaluation time, and a value captured then is permanently empty.
 */
function appId(): string | null {
  return pushAppId(Constants.expoConfig?.extra);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type OneSignalModule = any;

function load(): OneSignalModule | null {
  try {
    // Resolved at runtime so a build without the package still bundles, and so
    // importing this module under plain Node cannot reach for a native binary.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-onesignal').OneSignal ?? null;
  } catch {
    return null;
  }
}

/** True when the SDK is compiled in *and* an App ID exists for this build. */
export function isAvailable(): boolean {
  return load() !== null && appId() !== null;
}

/* ---------------------------------------------------------------- state -- */

export type PushState = {
  /** The SDK was initialised against a real App ID. */
  configured: boolean;
  /** The OS has granted notification permission. Never asked for by this file. */
  permitted: boolean;
  /** OneSignal will actually deliver to this device. */
  optedIn: boolean;
  /** UTC epoch ms of the last successful tag upload, or null. */
  tagsPublishedAt: number | null;
};

const state: PushState = {
  configured: false,
  permitted: false,
  optedIn: false,
  tagsPublishedAt: null,
};

let published: BriefingTags | null = null;
let lastRefreshAt: number | null = null;
let appStateSubscription: { remove: () => void } | null = null;
let started = false;

/** What the diagnostics screen would show. A copy: nothing outside may mutate it. */
export function pushStatus(): PushState {
  return { ...state };
}

/* ------------------------------------------------------------------ init -- */

/**
 * Idempotent. Safe to call from a Fast Refresh, and safe to call on a build
 * with no App ID — that path logs once and returns.
 */
export async function initialisePush(): Promise<Result<PushState>> {
  if (started) return ok(pushStatus());
  started = true;

  const OneSignal = load();
  const id = appId();
  if (!OneSignal || !id) {
    // Deliberately `info`, not `warn`. Every development build is in this
    // state, and a warning on each launch trains people to ignore the log.
    log.info('push not configured', { sdk: OneSignal !== null, appId: id !== null });
    return ok(pushStatus());
  }

  try {
    OneSignal.initialize(id);
    state.configured = true;

    // `initialize` does not prompt — the v3 SDK did, the v5 one does not — and
    // nothing in this file asks either. Permission is granted through the
    // Settings screen's own toggle (`useSystem.ts`), which is a deliberate act
    // the user can connect to a consequence.
    OneSignal.Notifications.addEventListener('click', onNotificationClick);

    // The Android channel a briefing push should land in. Registered by the
    // local side; naming it here so the dashboard's
    // `existing_android_channel_id: "briefing"` has something to attach to, and
    // so a user who mutes the briefing keeps their reminders.
    await configureNotifications().catch(() => {});

    await reconcileSubscription();
    // Not awaited: the first tag upload reads the whole briefing, and startup
    // must not wait on seven repository queries to hand over the splash screen.
    void refreshBriefingTags({ force: true });

    appStateSubscription?.remove();
    appStateSubscription = AppState.addEventListener('change', onAppStateChange);

    log.info('push ready', pushStatus());
    return ok(pushStatus());
  } catch (error) {
    // A push project that will not start is a reason to have no briefing push.
    // It is never a reason to fail a launch.
    log.warn('push could not be initialised', error);
    return fail('unknown', 'Push notifications could not be set up.', { cause: error });
  }
}

/* ----------------------------------------------------------- subscription -- */

/**
 * Brings OneSignal's opt-in state into line with what the OS has granted.
 *
 * Run at startup and on every return to the foreground, because the grant
 * usually happens *elsewhere*: the user turns reminders on in Settings, or
 * flips Ridik back on in the system's own notification list. Without this the
 * briefing would stay silently undeliverable until the next cold start.
 */
async function reconcileSubscription(): Promise<void> {
  const OneSignal = load();
  if (!OneSignal || !state.configured) return;

  try {
    // Asked without `prompt`, so this can never raise a dialog. The shared
    // helper is used rather than OneSignal's own so that "does Ridik have
    // permission" has exactly one answer across the app — including the
    // provisional authorisation iOS grants a quiet notification.
    const permission = await ensurePermission();
    state.permitted = permission.ok;

    const optedIn = Boolean(await OneSignal.User.pushSubscription.getOptedInAsync());
    if (shouldOptIn(state.permitted, optedIn)) {
      OneSignal.User.pushSubscription.optIn();
      state.optedIn = true;
      log.info('push subscription opted in');
      return;
    }
    state.optedIn = optedIn;
  } catch (error) {
    log.warn('could not read the push subscription', error);
  }
}

/**
 * The half of a "daily briefing push" switch that a Settings row cannot write
 * itself: opting out and taking the published tags back with it.
 *
 * Turning it *on* deliberately refuses rather than prompting. `optIn()` raises
 * the system permission dialog when permission is missing, and a dialog that
 * appears from a toggle the user has not been told about is the behaviour this
 * whole file is arranged to avoid — the caller prompts first, through
 * `ensurePermission({ prompt: true })`, and then calls this.
 */
export async function setPushEnabled(enabled: boolean): Promise<Result<PushState>> {
  const OneSignal = load();
  if (!OneSignal || !state.configured) {
    return fail('unsupported', 'This build has no push notifications.');
  }

  try {
    if (!enabled) {
      OneSignal.User.pushSubscription.optOut();
      // The tags describe a day. Leaving them on a user who has opted out means
      // an accidental send still knows what they were doing last Tuesday.
      OneSignal.User.removeTags([...BRIEFING_TAG_KEYS]);
      published = null;
      state.optedIn = false;
      state.tagsPublishedAt = null;
      return ok(pushStatus());
    }

    const permission = await ensurePermission();
    state.permitted = permission.ok;
    if (!permission.ok) return permission;

    OneSignal.User.pushSubscription.optIn();
    state.optedIn = true;
    void refreshBriefingTags({ force: true });
    return ok(pushStatus());
  } catch (error) {
    return fail('unknown', 'Push notifications could not be changed.', { cause: error });
  }
}

/* ------------------------------------------------------------------ tags -- */

/**
 * Publishes today's briefing to OneSignal as data tags.
 *
 * This is what makes a remote push able to speak in the app's own voice: the
 * dashboard's message is a template, and the sentence it renders is the one
 * `composeVisual` already wrote for the card. The cost is a freshness bound —
 * the line is as new as the last time Ridik was open, which for the returning
 * user this feature exists for is last night.
 *
 * `@/features/briefing` is imported at call time. It reaches the repositories
 * and the TTS voice, and neither belongs in the import graph of a module that
 * runs during bootstrap.
 */
export async function refreshBriefingTags(
  { force = false }: { force?: boolean } = {},
): Promise<Result<BriefingTags | null>> {
  const OneSignal = load();
  if (!OneSignal || !state.configured) return ok(null);

  const at = now();
  if (!force && !dueForRefresh(lastRefreshAt, at)) return ok(published);
  lastRefreshAt = at;

  try {
    const { generateBriefing } = await import('@/features/briefing');
    const briefing = await generateBriefing('today');
    if (!briefing.ok) {
      // A briefing that cannot be built must not overwrite a good line with a
      // blank one; yesterday's is wrong by a day, an empty tag is wrong by a
      // whole notification.
      log.warn('briefing unavailable; tags left as they were', briefing.error.userMessage);
      return ok(published);
    }

    const tags = briefingPushTags(briefing.value);
    if (!tagsChanged(published, tags)) return ok(published);

    OneSignal.User.addTags(tags);
    published = tags;
    state.tagsPublishedAt = at;
    log.debug('briefing tags published', { date: tags.briefing_date, quiet: tags.briefing_quiet });
    return ok(tags);
  } catch (error) {
    log.warn('could not publish briefing tags', error);
    return fail('unknown', 'The briefing could not be sent to the push service.', {
      cause: toAppError(error),
    });
  }
}

/* ------------------------------------------------------------- app state -- */

function onAppStateChange(status: AppStateStatus): void {
  if (status === 'active') {
    // The grant may have happened in system settings while we were away.
    void reconcileSubscription();
    void refreshBriefingTags();
    return;
  }
  if (status === 'background') {
    // The most valuable refresh there is: whatever the day looked like the last
    // time the phone was put down is what tomorrow's push will describe. Forced
    // past the interval guard, because the upload is skipped anyway when the
    // tags have not actually changed.
    void refreshBriefingTags({ force: true });
  }
}

/* ----------------------------------------------------------------- taps -- */

/**
 * Where a tapped push goes.
 *
 * The routing is not left to OneSignal's own launch-URL handling: that opens
 * the deep link outside expo-router's navigation state, which on a cold start
 * lands on "Unmatched Route" often enough to matter. `resolvePushHref` decides,
 * against an allow-list, and this only drives.
 */
function onNotificationClick(event: unknown): void {
  const click = (event ?? {}) as {
    notification?: { additionalData?: unknown };
    result?: { url?: unknown };
  };
  const href = resolvePushHref(
    { data: click.notification?.additionalData, url: click.result?.url },
    BRIEFING_HREF,
  );
  if (href === null) {
    log.info('push tap carried no route it is allowed to open');
    return;
  }
  navigate(href);
}

/**
 * Out of the native callback and onto a clean JS tick before navigating.
 *
 * On a cold launch this listener is registered from the bootstrap step, which
 * runs from the root layout's effect — after `<Stack>` has mounted, so the
 * navigator exists. It is the *event* that arrives early: OneSignal replays a
 * cached launch tap the instant a listener appears, and dispatching a
 * navigation from inside that call reaches expo-router mid-commit. One tick is
 * enough; the single retry covers a device slow enough that it is not.
 */
function navigate(href: string, attempt = 0): void {
  setTimeout(() => {
    try {
      router.navigate(href as never);
    } catch (error) {
      if (attempt === 0) {
        navigate(href, 1);
        return;
      }
      log.warn('could not open the pushed screen', error);
    }
  }, attempt === 0 ? 0 : 500);
}

/* ------------------------------------------------------------- bootstrap -- */

registerBootstrapStep({
  name: 'push',
  run: () => {
    // Not awaited. Nothing here is on the critical path to a usable app, and
    // the OneSignal SDK's first call reaches the network.
    void initialisePush();
  },
});
