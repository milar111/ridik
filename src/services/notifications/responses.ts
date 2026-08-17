/**
 * What happens when somebody taps a notification, or one of its buttons.
 *
 * ## What was wrong
 *
 * Nothing. Literally nothing happened.
 *
 * `subscribeToResponses()` and `getLaunchResponse()` were written, exported,
 * and called from nowhere. `addNotificationResponseReceivedListener` was never
 * installed, so no `actionIdentifier` and no `data.href` was ever read. Two
 * consequences, both invisible from the code:
 *
 *   - The ongoing focus notification's **Pause / Resume / Skip / Stop** buttons
 *     did nothing at all. `handleTimerAction()` in `services/focus/index.ts` was
 *     written for exactly this — complete with a guard against actions arriving
 *     from a stale notification — and was unreachable dead code. Its own
 *     docblock claimed "the root layout's single `subscribeToResponses`
 *     handler" forwarded to it. There was no such handler.
 *   - Every scheduled notification carries an `href` — `/focus`, `/tasks`,
 *     `/places` — and tapping the body never opened it. The app just resumed
 *     wherever it had been.
 *
 * ## Why it lives here and not in the root layout
 *
 * The layout must mount its navigator on the first render, so it is the wrong
 * place for anything that can throw or await. This is a bootstrap step like
 * push, and it deliberately mirrors `push.ts`: the same one-tick deferral
 * before navigating, for the same reason — a launch response is replayed the
 * instant a listener appears, and dispatching a navigation from inside that
 * call reaches expo-router mid-commit.
 *
 * ## The honest limit
 *
 * This restores Android. On iOS there is a second, independent cause — the
 * delegate conflict documented in `notifications/index.ts` — so taps there are
 * not fixed by this file and are not claimed to be.
 */
import { router } from 'expo-router';

import { createLogger } from '@/core/logger';
import { registerBootstrapStep } from '@/startup/bootstrap';

import { getLaunchResponse, subscribeToResponses, type NotificationPayload } from './local';

const log = createLogger('notifications/responses');

/** The button ids the focus notification carries. Anything else is a tap. */
const TIMER_ACTIONS = new Set(['pause', 'resume', 'skip', 'stop']);

/**
 * expo-notifications' own id for "the body was tapped, not a button".
 *
 * Compared against rather than assumed: a tap and an unknown action are
 * different events, and treating every non-timer id as a tap would route a
 * future button to a screen instead of running it.
 */
const TAPPED = 'expo.modules.notifications.actions.DEFAULT';

/**
 * Only the app's own routes, and only ones a notification has a reason to open.
 *
 * The same shape as `PUSH_BLOCKED_PARAMS` in `briefingPush.ts` and for the same
 * reason: `ridik:///?speak=1` is the one address in this app that is a verb,
 * and a notification that could carry it would be a way to start a recording
 * from outside the app. A scheduled reminder opens a screen; it never acts.
 */
function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed.startsWith('/')) return null;
  // No query string at all. Nothing this app schedules needs one, and the
  // parameter — not the route — is what has to be refused.
  if (trimmed.includes('?') || trimmed.includes('#')) {
    log.warn('notification href carried a query string; opening the bare route', { href: trimmed });
    return trimmed.split(/[?#]/)[0] || null;
  }
  return trimmed;
}

/** One clean tick before navigating. See the note in `push.ts`. */
function navigate(href: string, attempt = 0): void {
  setTimeout(
    () => {
      try {
        router.navigate(href as never);
      } catch (error) {
        if (attempt === 0) {
          navigate(href, 1);
          return;
        }
        log.warn('could not open the notified screen', error);
      }
    },
    attempt === 0 ? 0 : 500,
  );
}

async function handle(response: {
  actionIdentifier: string;
  data: NotificationPayload;
}): Promise<void> {
  const { actionIdentifier, data } = response;

  if (TIMER_ACTIONS.has(actionIdentifier)) {
    // Required lazily rather than imported: the focus runtime pulls in
    // text-to-speech and the timer machinery, and a listener registered at boot
    // must not drag that into the startup graph for a button nobody may press.
    // `require` and not `await import()` — the `logic` test project runs under
    // plain Node without VM modules, where a dynamic import throws, and this is
    // the same shape `push.ts` uses to load its SDK.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { handleTimerAction } = require('@/services/focus') as {
      handleTimerAction: (
        action: string,
        data?: { entityId?: string },
      ) => Promise<{ ok: boolean; error?: unknown }>;
    };
    const result = await handleTimerAction(actionIdentifier, { entityId: data.entityId });
    if (!result.ok) log.warn('timer action failed', result.error);
    return;
  }

  if (actionIdentifier !== TAPPED) {
    log.info('ignored an unknown notification action', { actionIdentifier });
    return;
  }

  const href = safeHref(data.href);
  if (!href) return;
  navigate(href);
}

let unsubscribe: (() => void) | null = null;

/**
 * Idempotent on purpose: fast refresh re-runs the bootstrap, and two listeners
 * mean every tap is handled twice — which for a timer button means pausing and
 * then resuming.
 */
export function installNotificationResponses(): void {
  unsubscribe?.();
  unsubscribe = subscribeToResponses((response) => {
    void handle(response).catch((error) => log.error('notification response failed', error));
  });
}

registerBootstrapStep({
  name: 'notification-responses',
  run: async () => {
    installNotificationResponses();

    /*
     * The cold-start half.
     *
     * A notification that *launched* the app was delivered before any listener
     * existed, so the live subscription never sees it. `getLastNotificationResponseAsync`
     * is what replays it — and without this, tapping a reminder on a killed app
     * opened the app and dropped the route on the floor, which is the case the
     * href exists for in the first place.
     */
    const launch = await getLaunchResponse();
    if (launch) await handle(launch);
  },
});
