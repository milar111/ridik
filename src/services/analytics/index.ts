/**
 * `track()` — the one way anything in this app is counted.
 *
 * Three properties, and every caller depends on all three:
 *
 * - **It cannot throw.** Recording is fire-and-forget and must never be able to
 *   break a turn. Every failure — a closed database, a bad event, a full disk —
 *   is caught here, logged at `warn`, and dropped. A lost count is a rounding
 *   error; a lost sentence is the thing `LastAction` exists to prevent.
 * - **It cannot record what the union does not describe.** `parseEvent` runs
 *   before the write, so a caller that assembles the wrong shape loses the
 *   count rather than smuggling a field past the vocabulary.
 * - **It never leaves the device.** This module writes one SQLite row. Sending
 *   is `upload.ts`, is a separate opt-in, and is off unless the user turns it
 *   on. Layer 1 works, and is complete, with no network at all.
 */
import { createLogger } from '@/core/logger';
import { getRepositories } from '@/repositories';

import { parseEvent, type AnalyticsEvent } from './events';

const log = createLogger('analytics');

export * from './events';

/**
 * Count one event.
 *
 * Deliberately returns `void` rather than a promise: nothing should ever be
 * able to `await` a count, because a caller that awaits it is a caller whose
 * latency now depends on it.
 */
export function track(event: AnalyticsEvent): void {
  void record(event);
}

/** The awaited form, for tests and for the two call sites that want ordering. */
export async function record(event: AnalyticsEvent): Promise<void> {
  try {
    const parsed = parseEvent(event);
    if (!parsed) {
      // Not a thrown error: an event outside the union is a programming
      // mistake, and the correct response is to lose it loudly and carry on.
      log.warn('refused an event outside the vocabulary', { name: (event as { name?: string })?.name });
      return;
    }
    await getRepositories().appEvents.record(parsed.name, parsed.props);
  } catch (error) {
    log.warn('could not record', error);
  }
}
