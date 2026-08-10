/**
 * The task definitions themselves.
 *
 * Defined at module scope, as expo-task-manager requires: when the OS wakes the
 * app in the background there are no views and no navigation, only this bundle
 * being evaluated, and a task the runtime does not know about at that moment is
 * simply dropped.
 */
import { BackgroundTaskResult } from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { createLogger } from '@/core/logger';

import { scheduleNextBriefing } from './briefingScheduler';

export const BACKGROUND_SYNC_TASK = 'ridik.background-sync';

const log = createLogger('background-task');

export type BackgroundSyncOutcome = {
  calendarSynced: boolean;
  /** UTC epoch ms of the briefing this run booked, if any. */
  briefingAt: number | null;
};

/**
 * One background wake: pull the calendar, then re-book the briefing so its body
 * reflects whatever the sync just brought in.
 *
 * Exported so Settings can offer a "sync now" that exercises the exact same
 * path the OS does.
 */
export async function runBackgroundSync(): Promise<BackgroundSyncOutcome> {
  const outcome: BackgroundSyncOutcome = { calendarSynced: false, briefingAt: null };

  const sync = loadCalendarSync();
  if (sync) {
    try {
      await sync();
      outcome.calendarSynced = true;
    } catch (error) {
      // Expected offline, and after a revoked Google token. The briefing below
      // is still worth doing, so this is a warning and not a failed run.
      log.warn('calendar sync failed', error);
    }
  }

  const briefing = await scheduleNextBriefing();
  if (briefing.ok) outcome.briefingAt = briefing.value.at;
  else log.warn('briefing reschedule failed', briefing.error.message);

  return outcome;
}

type SyncEntryPoint = () => Promise<unknown>;

/**
 * The calendar service is resolved at call time and through `require`, not a
 * static import: this file must stay evaluable — and therefore the task must
 * stay definable — even when the calendar module throws while loading, which it
 * can, since it reaches for OAuth state and the native calendar permission.
 */
function loadCalendarSync(): SyncEntryPoint | null {
  try {
    const module = require('@/services/calendar') as Record<string, unknown>;
    for (const name of ['syncCalendar', 'runCalendarSync', 'sync']) {
      const candidate = module[name];
      if (typeof candidate === 'function') return candidate as SyncEntryPoint;
    }
    log.warn('calendar service exposes no sync entry point');
  } catch (error) {
    log.warn('calendar service unavailable', error);
  }
  return null;
}

let defined = false;

/**
 * Idempotent because Fast Refresh re-evaluates this module, and because
 * `registerBackgroundWork` calls it again on a cold start that already ran it.
 */
export function defineBackgroundTasks(): void {
  if (defined) return;
  defined = true;

  try {
    if (TaskManager.isTaskDefined(BACKGROUND_SYNC_TASK)) return;

    TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
      try {
        const outcome = await runBackgroundSync();
        log.info('background sync finished', outcome);
        return BackgroundTaskResult.Success;
      } catch (error) {
        // Nothing may escape this handler: iOS and Android both cut the
        // scheduling budget of apps whose background work crashes, so a bad run
        // has to be reported as a failed result rather than as an exception.
        log.error('background sync crashed', error);
        return BackgroundTaskResult.Failed;
      }
    });
  } catch (error) {
    // Web, and Expo Go on Android, have no TaskManager. Losing background sync
    // there is acceptable; failing to boot is not.
    defined = false;
    log.warn('background task could not be defined', error);
  }
}

defineBackgroundTasks();
