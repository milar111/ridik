/**
 * Which voice actions can be taken back, and by deleting what.
 *
 * Deliberately a short allow-list rather than a switch over every tool in the
 * contract. Undo here means "delete the single row that action created" — so a
 * tool only belongs on this list when it *always* creates exactly one row and
 * the id it reports *is* that row. Every entry was checked against the
 * executor; the exclusions below are the reason this is a list and not a rule.
 *
 * Pure and native-free so the allow-list can be asserted under plain Node. A
 * wrong entry here silently destroys data the user did not ask to lose, which
 * is precisely the failure a fuzzy match is forbidden from causing elsewhere.
 */
import type { VoiceOutcomeItem } from '@/features/voice/store';

/** Which delete undoes it. One per repository the allow-list can reach. */
export type UndoKind = 'task' | 'event' | 'activity' | 'transaction';

export type UndoableAction = {
  kind: UndoKind;
  id: string;
  /** "Task added: “call Dad”." — shown on the receipt beside the undo. */
  summary: string;
};

const UNDOABLE: Partial<Record<VoiceOutcomeItem['toolName'], UndoKind>> = {
  // `createTask` — always new, and the id is the task.
  task_add: 'task',
  // `softDelete` cascades to the travel buffer and leaves a tombstone, so the
  // remote copy is retracted too. A hard delete would strand both.
  calendar_add: 'event',
  // The id is the entry. `activity_log` is also the only activity tool in the
  // contract, so without this the sole route out of a mis-log is this button.
  activity_log: 'activity',
  ledger_add: 'transaction',

  // Not undoable, and each for its own reason:
  //
  // `habit_log`   reports `result.habit.id` — the habit, not the log entry.
  //               Deleting it would take the streak and every past entry with
  //               it, to undo one mis-heard word.
  // `note_create` upserts. "Added 3 lines to Shopping" returns the id of a note
  //               that already existed, and deleting it would throw away
  //               everything that was in it before this sentence.
  // `place_save`  upserts the same way.
  // every update  needs the prior values to restore, which nothing keeps.
  // every delete  needs the deleted row back, which only a tombstone gives —
  //               and only the calendar keeps one.
};

/**
 * The same list, as names.
 *
 * `src/llm/confirm.ts` decides which actions to show the user *before* they
 * run, and its rule is the complement of this one: a mistake the receipt can
 * take back does not need a question first, and a mistake it cannot does.
 * That module cannot import this map's values without pulling the voice store
 * behind it, so it keeps its own copy and `confirm.test.ts` asserts the two
 * are the same set. Exported for that assertion, not for callers.
 */
export const UNDOABLE_TOOLS = Object.keys(UNDOABLE) as VoiceOutcomeItem['toolName'][];

/**
 * The undo for an outcome item, or null when there is not one that is safe.
 *
 * A failed action is never undoable: it wrote nothing, and its `entityId` — if
 * it has one — points at whatever it was refusing to touch.
 */
export function undoableAction(item: VoiceOutcomeItem): UndoableAction | null {
  if (!item.ok || !item.entityId) return null;
  const kind = UNDOABLE[item.toolName];
  return kind ? { kind, id: item.entityId, summary: item.summary } : null;
}

/**
 * The one action a receipt offers to undo: the last one that can be.
 *
 * "The last one" and not "all of them" — a sentence can create three things,
 * and a button that silently removed all three would be a worse surprise than
 * the mis-parse it was there to fix.
 */
export function lastUndoable(items: readonly VoiceOutcomeItem[]): UndoableAction | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const undo = undoableAction(items[i]!);
    if (undo) return undo;
  }
  return null;
}
