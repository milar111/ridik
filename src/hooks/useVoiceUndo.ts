import { useCallback, useState } from 'react';

import type { UndoableAction } from '@/features/home/undo';
import { useDeleteEvent } from './useCalendar';
import { useRemoveActivityEntry } from './useHabits';
import { useDeleteTransaction } from './useLedger';
import { useDeleteTask } from './useTasks';

export type VoiceUndo = {
  run: (action: UndoableAction) => Promise<void>;
  isPending: boolean;
};

/**
 * Performs the undo `undoableAction` decided was safe.
 *
 * Each branch goes through the same mutation the corresponding screen uses, so
 * an undo invalidates exactly what a manual delete would and cannot leave a
 * screen showing a row that is gone.
 */
export function useVoiceUndo(): VoiceUndo {
  const deleteTask = useDeleteTask();
  const deleteEvent = useDeleteEvent();
  const removeActivity = useRemoveActivityEntry();
  const deleteTransaction = useDeleteTransaction();
  const [isPending, setPending] = useState(false);

  const run = useCallback(
    async (action: UndoableAction) => {
      setPending(true);
      try {
        switch (action.kind) {
          case 'task':
            await deleteTask.mutateAsync(action.id);
            return;
          case 'event':
            // Soft: the buffer goes with it and the remote copy is retracted.
            await deleteEvent.mutateAsync({ id: action.id });
            return;
          case 'activity':
            await removeActivity.mutateAsync(action.id);
            return;
          case 'transaction':
            await deleteTransaction.mutateAsync(action.id);
            return;
        }
      } finally {
        setPending(false);
      }
    },
    [deleteTask, deleteEvent, removeActivity, deleteTransaction],
  );

  return { run, isPending };
}
