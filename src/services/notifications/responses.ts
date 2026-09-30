/**
 * What happens when somebody taps a notification, or one of its buttons.
 *
 * `addNotificationResponseReceivedListener` is installed here, so two things
 * work:
 *
 *   - The ongoing focus notification's **Pause / Resume / Skip / Stop** buttons
 *     reach `handleTimerAction()` in `services/focus/index.ts`, which guards
 *     against actions arriving from a stale notification.
 *   - Every scheduled notification carries an `href` — `/focus`, `/tasks`,
 *     `/places` — and tapping the body opens it.
 *
 * ## Why it lives here and not in the root layout
 *
 * The layout must mount its navigator on the first render, so it is the wrong
 * place for anything that can throw or await. This is a bootstrap step, with a
 * one-tick deferral before navigating: a launch response is replayed the
 * instant a listener appears, and dispatching a navigation from inside that
 * call reaches expo-router mid-commit.
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
 * `ridik:///?speak=1` is the one address in this app that is a verb, and a
 * notification that could carry it would be a way to start a recording from
 * outside the app. A scheduled reminder opens a screen; it never acts.
 *
 * This is the only enforcement point, so it is exported and tested by name
 * rather than left as a private helper.
 */
export function safeHref(href: unknown): string | null {
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

/** One clean tick before navigating, so the navigation is not mid-commit. */
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
    // plain Node without VM modules, where a dynamic import throws.
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
