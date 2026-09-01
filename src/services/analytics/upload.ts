/**
 * Layer 2 — the opt-in upload. Off by default, and inert without a backend.
 *
 * Two independent switches have to be on before a byte moves, and they fail in
 * different directions on purpose:
 *
 * - **The person.** `mayUploadAnalytics()` in `src/llm/consent.ts` — the switch
 *   is on *and* the disclosure has been answered. That function documents why
 *   it is `hasAnsweredConsent` rather than `mayReachProvider`; read it before
 *   changing this.
 * - **The build.** `assistantApiUrl()` is empty unless `EXPO_PUBLIC_RIDIK_API_URL`
 *   was set at build time, and a build with no backend has nowhere to send
 *   anything. This is the same capability-detected shape as
 *   `services/focus/liveActivity.ts` and `services/widgets/publish.ts`: absent
 *   infrastructure is a no-op, never an error and never a queue that grows for
 *   ever. **Layer 1 is complete without this file** — the ledger is written,
 *   readable and exportable whether or not this ever succeeds.
 *
 * What travels is exactly what the Usage screen shows, minus the row id and
 * minus the millisecond timestamp: `appEvents.unsent()` returns that shape and
 * this module does not reshape it. That is the property that makes the screen a
 * disclosure rather than a decoration — if this file transformed the rows, the
 * screen would no longer be showing what is sent.
 */
import { createLogger } from '@/core/logger';
import { now } from '@/core/clock';
import { assistantApiUrl } from '@/features/voice/mode';
import { mayUploadAnalytics } from '@/llm/consent';
import { getRepositories } from '@/repositories';

const log = createLogger('analytics/upload');

/** One request's worth. A few kilobytes; the cap is about the server, not the phone. */
const BATCH = 200;

/** Don't hold the app open on a counter. */
const TIMEOUT_MS = 10_000;

/** Foreground flushes are rate-limited to this; background ones are not. */
const FOREGROUND_INTERVAL_MS = 60 * 60 * 1000;

let lastFlushAt = 0;

/** Whether this build has anywhere to send to at all. */
export function isUploadConfigured(): boolean {
  return assistantApiUrl().length > 0;
}

async function allowed(): Promise<boolean> {
  if (!isUploadConfigured()) return false;
  const settings = getRepositories().settings;
  const [consent, optIn] = await Promise.all([
    settings.get('assistantConsent'),
    settings.get('analyticsOptIn'),
  ]);
  return mayUploadAnalytics({ consent, optIn });
}

/**
 * Send one batch if there is one, and mark it.
 *
 * `uploaded_at` is the only mutation, and it is written *after* the server has
 * acknowledged — so a failure re-sends rather than silently dropping, and a
 * crash between the POST and the mark costs a duplicate rather than a hole.
 * Duplicates are the right side of that trade for counters: an over-count is
 * visible in the data, a hole is not.
 */
export async function flush(options: { reason?: 'background' | 'foreground' | 'task' } = {}): Promise<void> {
  try {
    if (!(await allowed())) return;

    if (options.reason === 'foreground' && now() - lastFlushAt < FOREGROUND_INTERVAL_MS) return;

    const repo = getRepositories().appEvents;
    const { ids, events } = await repo.unsent(BATCH);
    if (events.length === 0) {
      lastFlushAt = now();
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${assistantApiUrl().replace(/\/+$/, '')}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // No identifier of any kind, and deliberately no header that could
        // become one. The server sees a batch of counters and an IP, which is
        // the least it can see and still receive an HTTP request.
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Retried on the next flush. Nothing is marked, so nothing is lost.
      log.warn('server refused the batch', { status: response.status, count: events.length });
      return;
    }

    await repo.markUploaded(ids);
    lastFlushAt = now();
    log.info('sent', { count: events.length });
  } catch (error) {
    // Offline is the common case and is not worth a warning louder than this.
    log.warn('could not send', error);
  }
}

/** Test seam: the foreground rate limit is module state. */
export function resetUploadThrottleForTests(): void {
  lastFlushAt = 0;
}
