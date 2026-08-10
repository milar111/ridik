/**
 * The Android presence for a running session: one ongoing notification on the
 * `timers` channel, carrying the phase, the countdown and Pause / Skip / Stop.
 *
 * Two constraints shape this file. Android throttles a notification that is
 * re-posted too often — the shade starts dropping updates and the row flickers
 * — so anything that is not a phase or run-state change is rate limited to one
 * post every 30 seconds, with the last suppressed update replayed on the
 * trailing edge so the countdown never stalls on a stale number. And the
 * notification must be re-postable in place, which is what the stable
 * identifier is for: posting the same id updates the row instead of stacking a
 * new one.
 */
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

const log = createLogger('focus-ongoing');

const MIN_UPDATE_INTERVAL_MS = 30_000;
const ONGOING_ID = 'ridik.focus.ongoing';

let live = false;
let lastPostedAt = 0;
let lastPhaseIndex: number | null = null;
let lastStatus: string | null = null;
let pending: FocusSnapshot | null = null;
let trailing: ReturnType<typeof setTimeout> | null = null;
let actionsFor: string | null = null;

export function isSupported(): boolean {
  return Platform.OS === 'android';
}

export async function start(snapshot: FocusSnapshot): Promise<void> {
  if (!isSupported()) return;
  live = true;
  await post(snapshot, true);
}

export async function update(snapshot: FocusSnapshot): Promise<void> {
  if (!isSupported() || !live) return;
  const changed = snapshot.phaseIndex !== lastPhaseIndex || snapshot.status !== lastStatus;
  await post(snapshot, changed);
}

export async function end(_snapshot: FocusSnapshot | null): Promise<void> {
  if (!isSupported()) return;
  clearTrailing();
  live = false;
  pending = null;
  lastPhaseIndex = null;
  lastStatus = null;
  await Notifications.dismissNotificationAsync(ONGOING_ID).catch(() => {});
  await Notifications.cancelScheduledNotificationAsync(ONGOING_ID).catch(() => {});
}

async function post(snapshot: FocusSnapshot, force: boolean): Promise<void> {
  const at = now();
  const since = at - lastPostedAt;
  if (!force && since < MIN_UPDATE_INTERVAL_MS) {
    pending = snapshot;
    armTrailing(MIN_UPDATE_INTERVAL_MS - since);
    return;
  }
  clearTrailing();
  pending = null;
  lastPostedAt = at;
  lastPhaseIndex = snapshot.phaseIndex;
  lastStatus = snapshot.status;
  await write(snapshot);
}

function armTrailing(delay: number): void {
  if (trailing) return;
  trailing = setTimeout(
    () => {
      trailing = null;
      const next = pending;
      pending = null;
      if (next && live) void post(next, true);
    },
    Math.max(250, delay),
  );
}

function clearTrailing(): void {
  if (!trailing) return;
  clearTimeout(trailing);
  trailing = null;
}

async function write(snapshot: FocusSnapshot): Promise<void> {
  const permission = await ensurePermission();
  if (!permission.ok) {
    // Without permission there is no surface to keep alive; stop trying until
    // the next session starts.
    live = false;
    log.warn('no notification permission; the ongoing timer is off');
    return;
  }
  await ensureActions(snapshot.status);

  const paused = snapshot.status === 'paused';
  const heading = paused ? 'Paused' : snapshot.phase.kind === 'break' ? 'Break' : 'Focus';
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: ONGOING_ID,
      content: {
        title: `${heading} · ${snapshot.clock}`,
        body: `${snapshot.label} — phase ${snapshot.phaseIndex + 1} of ${snapshot.phaseCount}`,
        sticky: true,
        autoDismiss: false,
        sound: false,
        priority: Notifications.AndroidNotificationPriority.LOW,
        categoryIdentifier: CATEGORIES.timer,
        data: { kind: 'timer', entityId: snapshot.sessionId, href: '/focus' },
      },
      trigger: { channelId: CHANNELS.timers },
    });
  } catch (error) {
    log.warn('could not post the ongoing timer', toAppError(error).message);
  }
}

/**
 * `configureNotifications()` registers the timer category with Skip and Stop.
 * A running timer wants Pause too — and a paused one wants Resume in its place,
 * since three buttons is all Android shows — so the category is re-registered
 * here whenever the run state changes. Registering an existing id replaces its
 * action set, and awaiting `configureNotifications()` first keeps it from
 * overwriting ours later.
 */
async function ensureActions(status: string): Promise<void> {
  const wanted = status === 'paused' ? 'paused' : 'running';
  if (actionsFor === wanted) return;
  actionsFor = wanted;
  await configureNotifications();
  const first =
    wanted === 'paused'
      ? { identifier: 'resume', buttonTitle: 'Resume' }
      : { identifier: 'pause', buttonTitle: 'Pause' };
  await Notifications.setNotificationCategoryAsync(CATEGORIES.timer, [
    { ...first, options: { opensAppToForeground: false } },
    { identifier: 'skip', buttonTitle: 'Skip', options: { opensAppToForeground: false } },
    { identifier: 'stop', buttonTitle: 'Stop', options: { opensAppToForeground: false } },
  ]).catch((error) => {
    actionsFor = null;
    log.warn('could not register the timer actions', toAppError(error).message);
  });
}
