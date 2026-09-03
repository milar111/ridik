/**
 * The keeping place, kept across the app being killed.
 *
 * `recovered` is the one thing in the voice store that is not about the current
 * turn — it is the sentence the user said and never got an answer to, and
 * `Unsent.tsx` says outright what it is for: "the user is mid-corridor, the
 * model timed out, and the paragraph they dictated has to still be there when
 * they get somewhere they can look at a screen."
 *
 * That window is precisely the one in which iOS and Android reclaim a
 * backgrounded app. Held only in zustand, the slot survived every failure it
 * was designed for and none of the ordinary one: pocket the phone, come back
 * ten minutes later, and the words are gone from a feature whose entire promise
 * is that they are not. Nothing else in the app persists UI state, which is why
 * it went unnoticed — nothing else in the app holds something the user cannot
 * get back.
 *
 * Three decisions worth keeping:
 *
 *  - **A file, not the database.** The store must stay importable under plain
 *    Node — `store.ts` may not reach a repository, and the `logic` project runs
 *    its tests with no SQLite mock and no native modules. This module is the
 *    native half and the store never imports it; it subscribes from outside.
 *  - **The documents directory, for the same reason backups live there.** The
 *    OS deletes a cache the moment storage runs low, which is exactly when
 *    somebody is about to need this.
 *  - **A restore never overwrites.** Whatever this session has already put in
 *    the slot is newer than anything on disk, always.
 */
import { Directory, File, Paths } from 'expo-file-system';

import { createLogger } from '@/core/logger';
import { registerBootstrapStep } from '@/startup/bootstrap';

import { useVoiceStore, type RecoveredTranscript } from './store';

const log = createLogger('voice/keep');

const FOLDER = 'voice';
const NAME = 'unsent.json';

/**
 * The same ceiling the text box enforces. A file that has been corrupted into
 * something enormous must not be read into a `Text` node whole.
 */
const MAX_CHARS = 20_000;

function slot(): File {
  return new File(new Directory(Paths.document, FOLDER), NAME);
}

/** Anything that is not exactly what we wrote is nothing. */
function parse(raw: string): RecoveredTranscript | null {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (!text) return null;
  const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0;
  const reason = record.reason === 'failed' ? 'failed' : 'unsent';
  return { text: text.slice(0, MAX_CHARS), at, reason };
}

/** Nothing here may throw: it runs during bootstrap and on every store change. */
export function readKeptTranscript(): RecoveredTranscript | null {
  try {
    const file = slot();
    if (!file.exists) return null;
    return parse(file.textSync());
  } catch (error) {
    log.warn('could not read the kept transcript', error);
    return null;
  }
}

export function writeKeptTranscript(kept: RecoveredTranscript | null): void {
  try {
    const file = slot();
    if (!kept) {
      if (file.exists) file.delete();
      return;
    }
    const directory = new Directory(Paths.document, FOLDER);
    if (!directory.exists) directory.create({ intermediates: true });
    file.create({ overwrite: true, intermediates: true });
    file.write(
      JSON.stringify({
        text: kept.text.slice(0, MAX_CHARS),
        at: kept.at,
        reason: kept.reason,
      }),
    );
  } catch (error) {
    log.warn('could not keep the transcript', error);
  }
}

/**
 * The user's own words, on disk, outside the database.
 *
 * "Delete all data" empties SQLite and nothing else, which is true of the
 * backups too and is now said on that screen — but a backup is a file the user
 * asked for and can see. This one they never asked for, so erasing has to take
 * it, or the feature would quietly create the exact leak the erase copy was
 * just corrected for.
 */
export function clearKeptTranscript(): void {
  useVoiceStore.getState().discardRecovered();
  writeKeptTranscript(null);
}

let unsubscribe: (() => void) | null = null;

/** Idempotent. Restores the slot, then mirrors it for the rest of the session. */
export function installTranscriptKeeper(): void {
  if (unsubscribe) return;

  const kept = readKeptTranscript();
  // Bootstrap is async and the navigator is already mounted, so a turn can in
  // principle have happened before this runs. What is in the store now is
  // newer than anything on disk, by definition.
  if (kept && !useVoiceStore.getState().recovered) useVoiceStore.setState({ recovered: kept });

  unsubscribe = useVoiceStore.subscribe((state, previous) => {
    if (state.recovered !== previous.recovered) {
      // Emptied *into the composer* rather than thrown away. The dock's draft
      // is React state and dies with the process exactly like the slot used
      // to, so the file stays put until the sentence is discarded or actually
      // goes through — "Edit" must not be the tap that loses it.
      if (!state.recovered && state.draftSeed) return;
      writeKeptTranscript(state.recovered);
      return;
    }
    // A turn that landed retires whatever is still on disk. Needed because the
    // branch above cannot see it: a sentence sent *from* the composer was
    // already out of the slot, so nothing about `recovered` changes and a stale
    // copy would be offered back on the next cold start.
    const landed =
      state.outcome !== previous.outcome && state.outcome != null && !state.outcome.failed;
    if (landed && !state.recovered) writeKeptTranscript(null);
  });
}

/**
 * Test hook, so a suite can install against its own filesystem mock.
 *
 * Really unsubscribes rather than only clearing a flag: a listener left behind
 * writes into the *next* test's filesystem, and the case this module exists for
 * — a restore that must not overwrite — is precisely the one a stale writer
 * makes pass for the wrong reason.
 */
export function resetTranscriptKeeper(): void {
  unsubscribe?.();
  unsubscribe = null;
}

registerBootstrapStep({
  name: 'voice-keep',
  run: () => {
    installTranscriptKeeper();
  },
});
