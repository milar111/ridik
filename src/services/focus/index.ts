/**
 * The focus timer, as the rest of the app sees it.
 *
 * This is the composition root: it binds the driver in `runtime.ts` — which
 * knows nothing about Expo — to the repository, the platform surface for this
 * OS, the notification scheduler and the app's foreground state. Screens, the
 * voice executor and the notification router talk to the facade at the bottom
 * and never to the runtime directly.
 */
import { AppState, Platform, type AppStateStatus } from 'react-native';

import { createLogger } from '@/core/logger';
import { fail, ok, type Result } from '@/core/result';
import { getRepositories } from '@/repositories';
import {
  CATEGORIES,
  CHANNELS,
  cancelForEntity,
  ensurePermission,
  scheduleAt,
} from '@/services/notifications';
import { registerBootstrapStep } from '@/startup/bootstrap';

import * as androidOngoing from './androidOngoing';
import * as liveActivity from './liveActivity';
import {
  createFocusRuntime,
  createToneChime,
  type FocusPlanInput,
  type FocusRuntime,
  type FocusScheduler,
  type FocusSnapshot,
  type FocusSurface,
} from './runtime';

export {
  buildPhases,
  plannedTransitions,
  snapshotOf,
  type ChimeKind,
  type FocusPlanInput,
  type FocusSnapshot,
  type PlannedTransition,
} from './runtime';

const log = createLogger('focus');

export type FocusControlAction = 'pause' | 'resume' | 'stop' | 'skip';

const platformSurface: FocusSurface = Platform.OS === 'android' ? androidOngoing : liveActivity;

/**
 * Phase changes are handed to the OS as dated local notifications so they still
 * announce themselves with the app backgrounded or killed. They are tagged with
 * the session id, which is how `cancel` clears the whole chain in one go.
 */
const scheduler: FocusScheduler = {
  async schedule(transitions, options) {
    if (transitions.length === 0) return;
    // Starting a session is a deliberate act, so that is the moment to ask;
    // rehydrating one after a restart must never raise the system dialog.
    const permission = await ensurePermission({ prompt: options?.userInitiated ?? false });
    if (!permission.ok) {
      log.warn('phase alarms are off', permission.error.userMessage);
      return;
    }
    for (const transition of transitions) {
      const scheduled = await scheduleAt({
        title: transition.title,
        body: transition.body,
        at: transition.at,
        channel: CHANNELS.timers,
        categoryIdentifier: CATEGORIES.timer,
        data: {
          kind: 'timer',
          entityId: transition.sessionId,
          phaseIndex: transition.phaseIndex,
          href: '/focus',
        },
      });
      if (!scheduled.ok) {
        log.warn('could not schedule a phase change', scheduled.error.message);
        return;
      }
    }
  },
  async cancel(sessionId) {
    await cancelForEntity(sessionId);
  },
};

let runtime: FocusRuntime | null = null;
let appStateSubscription: { remove(): void } | null = null;

export function getFocusRuntime(): FocusRuntime {
  if (runtime) return runtime;
  runtime = createFocusRuntime({
    repository: getRepositories().focus,
    surface: platformSurface,
    scheduler,
    chime: createToneChime(log),
    logger: log,
  });
  // The per-second ticker is a foreground concern: in the background the OS
  // holds the alarms and the next foreground pass reconciles the gap.
  appStateSubscription = AppState.addEventListener('change', onAppStateChange);
  runtime.setForeground(isForeground(AppState.currentState));
  return runtime;
}

/** Android reports `unknown` before the first transition; that is not "away". */
const isForeground = (state: AppStateStatus): boolean =>
  state !== 'background' && state !== 'inactive';

function onAppStateChange(state: AppStateStatus): void {
  runtime?.setForeground(isForeground(state));
}

/** Test/recovery hook — drops the singleton and its listeners. */
export function resetFocusRuntime(): void {
  runtime?.dispose();
  runtime = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
}

registerBootstrapStep({
  name: 'focus-runtime',
  run: async () => {
    const restored = await getFocusRuntime().rehydrate();
    if (restored) {
      log.info('resumed a focus session', { id: restored.sessionId, phase: restored.phaseIndex });
    }
  },
});

/* ---------------------------------------------------------------- facade -- */

export async function startFromPlan(input: FocusPlanInput): Promise<Result<FocusSnapshot>> {
  return getFocusRuntime().startPlan(input);
}

/** Drives a session that something else (the voice executor) already created. */
export async function startSession(sessionId: string): Promise<Result<FocusSnapshot>> {
  return getFocusRuntime().start(sessionId);
}

/**
 * Re-reads the store and re-drives whatever it finds. Use this after a write
 * that went straight to the repository, so the surface and the alarms catch up
 * without the row being changed a second time.
 */
export async function refresh(): Promise<FocusSnapshot | null> {
  return getFocusRuntime().rehydrate();
}

/**
 * The timer half of the voice executor's `ExecutorEffects`. It adopts the row
 * the executor has already written rather than repeating the mutation —
 * `control('skip')` here would advance the phase a second time.
 */
export const focusEffects = {
  startFocusSession: async (sessionId: string): Promise<void> => {
    await startSession(sessionId);
  },
  controlFocusSession: async (): Promise<void> => {
    await refresh();
  },
};

export async function control(action: FocusControlAction): Promise<Result<FocusSnapshot | null>> {
  const live = getFocusRuntime();
  switch (action) {
    case 'pause':
      return live.pause();
    case 'resume':
      return live.resume();
    case 'skip':
      return live.skipPhase();
    case 'stop':
      return live.stop();
    default:
      return fail('invalid_input', 'That is not something the timer can do.');
  }
}

export function subscribe(listener: (snapshot: FocusSnapshot | null) => void): () => void {
  return getFocusRuntime().subscribe(listener);
}

export function getSnapshot(): FocusSnapshot | null {
  return runtime?.getSnapshot() ?? null;
}

/**
 * Routes the notification action buttons. The root layout's single
 * `subscribeToResponses` handler forwards anything from the timer category,
 * passing the notification's own payload along with the action.
 *
 * The payload matters: a notification outlives the session that posted it, so
 * the button on a card from a session that has since been replaced would
 * otherwise pause or skip whatever is running now. An `entityId` that names a
 * different session is ignored rather than guessed at.
 */
export async function handleTimerAction(
  actionIdentifier: string,
  data?: { entityId?: string },
): Promise<Result<FocusSnapshot | null>> {
  switch (actionIdentifier) {
    case 'pause':
    case 'resume':
    case 'skip':
    case 'stop': {
      // The action can arrive before anything has been driven — a killed app
      // woken by the button — so adopt whatever is stored before acting.
      const live = getSnapshot() ?? (await refresh());
      const target = data?.entityId;
      if (target && live && live.sessionId !== target) {
        log.warn('ignored a timer action from a stale notification', target);
        return ok(live);
      }
      return control(actionIdentifier);
    }
    default:
      return ok(getSnapshot());
  }
}
