import type { VoiceOutcomeItem } from '@/features/voice/store';
import { lastUndoable, undoableAction } from '../undo';

const item = (over: Partial<VoiceOutcomeItem> & Pick<VoiceOutcomeItem, 'toolName'>): VoiceOutcomeItem => ({
  ok: true,
  summary: 'did a thing',
  entityId: 'row-1',
  ...over,
});

describe('undoableAction', () => {
  it('undoes the creates whose id really is the row they made', () => {
    expect(undoableAction(item({ toolName: 'task_add' }))?.kind).toBe('task');
    expect(undoableAction(item({ toolName: 'calendar_add' }))?.kind).toBe('event');
    expect(undoableAction(item({ toolName: 'activity_log' }))?.kind).toBe('activity');
    expect(undoableAction(item({ toolName: 'ledger_add' }))?.kind).toBe('transaction');
  });

  /* The whole reason this is an allow-list. `habit_log` reports the habit's id,
     not the log entry's — an undo wired by pattern rather than by inspection
     would delete the habit and every entry it ever had, to take back one word. */
  it('refuses to undo a habit log, whose id is the habit and not the entry', () => {
    expect(undoableAction(item({ toolName: 'habit_log' }))).toBeNull();
  });

  /* `note_create` upserts: "Added 3 lines to Shopping" hands back the id of a
     note that already existed and had its own contents. */
  it('refuses to undo a note write, which may have appended to an existing note', () => {
    expect(undoableAction(item({ toolName: 'note_create' }))).toBeNull();
  });

  it('refuses updates and deletes, which have no prior state to restore', () => {
    expect(undoableAction(item({ toolName: 'calendar_update' }))).toBeNull();
    expect(undoableAction(item({ toolName: 'note_delete' }))).toBeNull();
    expect(undoableAction(item({ toolName: 'task_complete' }))).toBeNull();
  });

  it('refuses an action that failed, whose id points at what it would not touch', () => {
    expect(undoableAction(item({ toolName: 'task_add', ok: false }))).toBeNull();
  });

  it('refuses when no row was reported', () => {
    expect(undoableAction({ toolName: 'task_add', ok: true, summary: 'added' })).toBeNull();
  });
});

describe('lastUndoable', () => {
  it('offers the last undoable action, not the last action', () => {
    // "Add milk to the list and remind me to call Dad" — the note is not
    // undoable, the task is, and the button must reach past it.
    const undo = lastUndoable([
      item({ toolName: 'task_add', entityId: 'task-9', summary: 'Task added' }),
      item({ toolName: 'note_create', entityId: 'note-3' }),
    ]);

    expect(undo).toEqual({ kind: 'task', id: 'task-9', summary: 'Task added' });
  });

  it('undoes one thing, not everything a sentence did', () => {
    const undo = lastUndoable([
      item({ toolName: 'task_add', entityId: 'task-1' }),
      item({ toolName: 'ledger_add', entityId: 'tx-2' }),
    ]);

    expect(undo).toEqual({ kind: 'transaction', id: 'tx-2', summary: 'did a thing' });
  });

  it('offers nothing when nothing in the turn can be taken back', () => {
    expect(lastUndoable([item({ toolName: 'habit_log' }), item({ toolName: 'search' })])).toBeNull();
    expect(lastUndoable([])).toBeNull();
  });
});
