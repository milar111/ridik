/**
 * Crash reporting — the one thing the local ledger cannot do.
 *
 * `app_events` records a `turn_error` when the app *handles* a failure. A hard
 * crash is by definition the case where nothing got to record anything, and
 * until now that meant a user's app dying on launch was completely invisible to
 * the operator. SETUP.md called it the biggest gap in the project and it was
 * right.
 *
 * Three gates, and all three have to be open:
 *
 * 1. **The package is present.** `@sentry/react-native` is loaded through an
 *    optional require, the same capability-detected shape as
 *    `services/focus/liveActivity.ts`. A build without it is not broken, it
 *    simply reports nothing — which is what every build did until this file.
 * 2. **A DSN was configured at build time.** No DSN, nowhere to send.
 * 3. **The person said yes.** `mayUploadAnalytics()` — the same single switch
 *    as the counts, off by default. This is the important one, and it is why
 *    initialisation is deliberately *late*: Sentry is normally started as early
 *    as possible so it catches the earliest crashes, and doing that here would
 *    mean registering a third party's global error handler before the person
 *    has been asked. Crashes in the first few hundred milliseconds go
 *    unreported. That is the correct side of the trade, and it is written down
 *    so nobody "fixes" it by hoisting the call.
 *
 * A crash report is a stack trace and the app's own state — not a note, not a
 * transcript, not a name. `beforeSend` below is what keeps that true rather
 * than merely likely.
 */
import Constants from 'expo-constants';

import { createLogger } from '@/core/logger';
import { mayUploadAnalytics } from '@/llm/consent';
import { getRepositories } from '@/repositories';

const log = createLogger('analytics/crash');

type SentryLike = {
  init: (options: Record<string, unknown>) => void;
  captureException?: (error: unknown) => void;
  close?: () => Promise<unknown>;
};

let sentry: SentryLike | null = null;
let started = false;

/** The DSN, or empty. Same `extra` channel as every other build-time value. */
export function crashDsn(): string {
  const extra = (Constants.expoConfig?.extra ?? {}) as { sentryDsn?: string };
  return (extra.sentryDsn ?? '').trim();
}

/** Whether this build could report a crash if the user allowed it. */
export function isCrashReportingConfigured(): boolean {
  return crashDsn().length > 0 && load() !== null;
}

function load(): SentryLike | null {
  if (sentry) return sentry;
  try {
    // Optional by design: `require` rather than `import` so a build without the
    // package compiles, bundles and runs. Same shape as `loadCalendarSync` in
    // `services/background/tasks.ts`, for the same reason.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@sentry/react-native') as SentryLike;
    sentry = typeof mod?.init === 'function' ? mod : null;
  } catch {
    sentry = null;
  }
  return sentry;
}

/**
 * Strip anything that could carry content out of a report before it leaves.
 *
 * Defence in depth rather than the primary control — the primary control is
 * that this app does not put user content into exception messages. But a
 * stack trace can pick up a breadcrumb from a fetch URL or a console line, and
 * "probably fine" is not the standard the rest of this file is held to.
 */
function scrub(event: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...event };
  // Breadcrumbs are where a URL, a console log or a user action ends up.
  delete cleaned.breadcrumbs;
  // Sentry's own notion of a user. There is no account here; there must be no
  // pseudonymous identity either.
  delete cleaned.user;
  delete cleaned.request;
  return cleaned;
}

/**
 * Start reporting if all three gates are open. Safe to call more than once.
 *
 * Called from the bootstrap sequence *after* settings are readable, and again
 * when the switch is turned on so the person does not have to relaunch.
 */
export async function initialiseCrashReporting(): Promise<boolean> {
  try {
    if (started) return true;

    const dsn = crashDsn();
    if (!dsn) return false;

    const client = load();
    if (!client) {
      log.info('no crash SDK in this build; nothing will be reported');
      return false;
    }

    const settings = getRepositories().settings;
    const [consent, optIn] = await Promise.all([
      settings.get('assistantConsent'),
      settings.get('analyticsOptIn'),
    ]);
    if (!mayUploadAnalytics({ consent, optIn })) return false;

    client.init({
      dsn,
      // No session replay, no profiling, no auto breadcrumbs that could carry
      // content, and no performance tracing: none of them answer "did it
      // crash", and every one of them widens what leaves the phone.
      enableAutoSessionTracking: false,
      enableAutoPerformanceTracing: false,
      tracesSampleRate: 0,
      sendDefaultPii: false,
      attachScreenshot: false,
      attachViewHierarchy: false,
      maxBreadcrumbs: 0,
      beforeSend: (event: Record<string, unknown>) => scrub(event),
      beforeBreadcrumb: () => null,
    });

    started = true;
    log.info('crash reporting on');
    return true;
  } catch (error) {
    // A crash reporter that crashes the app is worse than no crash reporter.
    log.warn('could not start crash reporting', error);
    return false;
  }
}

/**
 * Stop reporting when the switch goes off.
 *
 * Sentry cannot be fully unloaded in-process, so this closes the client and
 * latches `started` back: nothing further is sent, and a relaunch starts clean.
 * The Settings row says already-sent reports cannot be recalled, because they
 * cannot.
 */
export async function stopCrashReporting(): Promise<void> {
  try {
    if (!started || !sentry?.close) {
      started = false;
      return;
    }
    await sentry.close();
  } catch (error) {
    log.warn('could not stop crash reporting', error);
  } finally {
    started = false;
  }
}

/** Test seam. */
export function resetCrashReportingForTests(): void {
  started = false;
  sentry = null;
}
