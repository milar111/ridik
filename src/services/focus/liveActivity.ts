/**
 * The iOS presence for a running session: Dynamic Island and lock screen.
 *
 * A real Live Activity needs ActivityKit, which needs a widget extension
 * compiled into the binary — a native dependency this build does not carry.
 * Rather than pretend, this is a capability-detected adapter: it looks for the
 * module at runtime, uses it if it is there, and otherwise keeps a
 * time-sensitive notification on the lock screen so the phase and the finish
 * time are still visible.
 *
 * To light the real thing up:
 *   1. `npx expo install expo-live-activity`
 *   2. add its config plugin to `app.config.ts` (the entitlements it wants —
 *      `NSSupportsLiveActivities` and the time-sensitive entitlement — are
 *      already declared there) and give it a widget extension whose activity
 *      attributes match `LiveActivityState` below;
 *   3. `npx expo prebuild --clean && npx expo run:ios`.
 * Nothing here changes: `isSupported()` simply starts returning true.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { now } from '@/core/clock';
import { createLogger } from '@/core/logger';
import { toAppError } from '@/core/result';
import {
  CATEGORIES,
  CHANNELS,
  configureNotifications,
  ensurePermission,
} from '@/services/notifications';

import type { FocusSnapshot } from './runtime';

const log = createLogger('focus-live-activity');

/** Live Activities landed in 16.1; the compact/expanded APIs we want are 16.4. */
const MIN_IOS_VERSION = 16.4;

/** ActivityKit budgets updates from the app; the widget renders its own clock. */
const MIN_ACTIVITY_UPDATE_MS = 10_000;

/** One stable id, so each post replaces the previous lock-screen card. */
const FALLBACK_ID = 'ridik.focus.ios';

/** What the widget extension is handed on every update. */
export type LiveActivityState = {
  label: string;
  subject: string | null;
  phase: 'focus' | 'break';
  phaseIndex: number;
  phaseCount: number;
  status: string;
  /** UTC epoch ms; the widget turns it into the `Date` ActivityKit counts to. */
  endsAt: number | null;
  remainingSeconds: number;
};

type LiveActivityModule = {
  startActivity(
    attributes: Record<string, unknown>,
    state: LiveActivityState,
  ): Promise<string> | string;
  updateActivity(id: string, state: LiveActivityState): Promise<void> | void;
  endActivity(id: string, state?: LiveActivityState): Promise<void> | void;
  areActivitiesEnabled?: () => boolean;
};

let module$: LiveActivityModule | null | undefined;
let activityId: string | null = null;
let lastActivityUpdate = 0;
let lastPhaseIndex: number | null = null;
let lastStatus: string | null = null;
let fallbackKey: string | null = null;

/**
 * Two ways in, both optional. The JS package is preferred because it owns the
 * attribute encoding; the bare native module is the fallback for a custom
 * widget wired straight into Expo modules.
 */
function resolveModule(): LiveActivityModule | null {
  if (module$ !== undefined) return module$;
  module$ = loadPackage() ?? loadNativeModule();
  if (!module$) log.debug('no Live Activity module in this binary');
  return module$;
}

function loadPackage(): LiveActivityModule | null {
  try {
    // Not installed today. Metro treats a require inside a try/catch as an
    // optional dependency, so this throws at runtime instead of at build time.
    const loaded = require('expo-live-activity') as { default?: unknown } & Record<string, unknown>;
    const api = (loaded?.default ?? loaded) as Partial<LiveActivityModule> | undefined;
    return api && typeof api.startActivity === 'function' ? (api as LiveActivityModule) : null;
  } catch {
    return null;
  }
}

function loadNativeModule(): LiveActivityModule | null {
  try {
    const native = requireOptionalNativeModule<Partial<LiveActivityModule>>('ExpoLiveActivity');
    const usable = native && typeof native.startActivity === 'function';
    return usable ? (native as LiveActivityModule) : null;
  } catch {
    return null;
  }
}

function iosVersion(): number {
  const parsed = Number.parseFloat(String(Platform.Version));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isSupported(): boolean {
  if (Platform.OS !== 'ios' || iosVersion() < MIN_IOS_VERSION) return false;
  const api = resolveModule();
  if (!api) return false;
  if (!api.areActivitiesEnabled) return true;
  try {
    // The user can turn Live Activities off for the app in Settings.
    return api.areActivitiesEnabled() !== false;
  } catch {
    return false;
  }
}

function stateOf(snapshot: FocusSnapshot): LiveActivityState {
  return {
    label: snapshot.label,
    subject: snapshot.subject,
    phase: snapshot.phase.kind,
    phaseIndex: snapshot.phaseIndex,
    phaseCount: snapshot.phaseCount,
    status: snapshot.status,
    endsAt: snapshot.phaseEndsAt,
    remainingSeconds: Math.round(snapshot.phaseRemainingMs / 1000),
  };
}

export async function start(snapshot: FocusSnapshot): Promise<void> {
  if (Platform.OS !== 'ios') return;
  if (isSupported()) {
    const api = resolveModule()!;
    try {
      const id = await api.startActivity(
        { sessionId: snapshot.sessionId, label: snapshot.label },
        stateOf(snapshot),
      );
      if (typeof id === 'string' && id.length > 0) {
        activityId = id;
        lastActivityUpdate = now();
        remember(snapshot);
        // Belt and braces: a fallback card from an earlier run would otherwise
        // sit on the lock screen underneath the real activity.
        await dismissFallback();
        return;
      }
      log.warn('the Live Activity module returned no handle');
    } catch (error) {
      log.warn('could not start the Live Activity', toAppError(error).message);
      activityId = null;
    }
  }
  await postFallback(snapshot);
}

export async function update(snapshot: FocusSnapshot): Promise<void> {
  if (Platform.OS !== 'ios') return;
  if (activityId) {
    const at = now();
    const phaseChanged = snapshot.phaseIndex !== lastPhaseIndex || snapshot.status !== lastStatus;
    if (!phaseChanged && at - lastActivityUpdate < MIN_ACTIVITY_UPDATE_MS) return;
    lastActivityUpdate = at;
    try {
      await resolveModule()?.updateActivity(activityId, stateOf(snapshot));
      remember(snapshot);
      return;
    } catch (error) {
      log.warn('could not update the Live Activity', toAppError(error).message);
    }
  }
  await postFallback(snapshot);
}

export async function end(snapshot: FocusSnapshot | null): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const id = activityId;
  activityId = null;
  lastPhaseIndex = null;
  lastStatus = null;
  if (id) {
    try {
      await resolveModule()?.endActivity(id, snapshot ? stateOf(snapshot) : undefined);
    } catch (error) {
      log.warn('could not end the Live Activity', toAppError(error).message);
    }
  }
  await dismissFallback();
}

/* -------------------------------------------------------------- fallback -- */

function headingFor(snapshot: FocusSnapshot): string {
  if (snapshot.status === 'paused') return 'Paused';
  return snapshot.phase.kind === 'break' ? 'Break' : 'Focus';
}

function remember(snapshot: FocusSnapshot): void {
  lastPhaseIndex = snapshot.phaseIndex;
  lastStatus = snapshot.status;
}

/**
 * Without ActivityKit the lock screen gets a notification instead. It is
 * re-posted under one identifier — iOS replaces a delivered notification whose
 * id matches — and only when the phase or the run state changes, because a
 * banner per second would be unusable.
 */
async function postFallback(snapshot: FocusSnapshot): Promise<void> {
  const key = `${snapshot.phaseIndex}:${snapshot.status}`;
  if (key === fallbackKey) return;

  const permission = await ensurePermission();
  if (!permission.ok) return;
  await configureNotifications();

  const heading = headingFor(snapshot);
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: FALLBACK_ID,
      content: {
        title: `${heading} · ${snapshot.clock}`,
        body: `${snapshot.label} — phase ${snapshot.phaseIndex + 1} of ${snapshot.phaseCount}`,
        sound: false,
        // Time-sensitive breaks through Focus modes, which is the whole point
        // of a running timer the user asked for.
        interruptionLevel: 'timeSensitive',
        categoryIdentifier: CATEGORIES.timer,
        data: { kind: 'timer', entityId: snapshot.sessionId, href: '/focus' },
      },
      trigger: { channelId: CHANNELS.timers },
    });
    fallbackKey = key;
    remember(snapshot);
  } catch (error) {
    log.warn('could not post the lock-screen notification', toAppError(error).message);
  }
}

async function dismissFallback(): Promise<void> {
  fallbackKey = null;
  await Notifications.dismissNotificationAsync(FALLBACK_ID).catch(() => {});
  await Notifications.cancelScheduledNotificationAsync(FALLBACK_ID).catch(() => {});
}
