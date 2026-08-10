/**
 * The write side of the tasks tab, in one place.
 *
 * Every list and both sheets need the same four verbs, and completing a task is
 * the app's headline behaviour: when a prerequisite closes, the chain moves and
 * the user has to feel it. That announcement lives here so it cannot be
 * implemented once per list and drift.
 */
import { useCallback, useMemo } from 'react';
import * as Haptics from 'expo-haptics';

import { countLabel, joinNatural } from '@/core/format';
import { toAppError } from '@/core/result';
import type { Task } from '@/db/schema';
import {
  useCompleteTask,
  useDeleteTask,
  useUncompleteTask,
  useUpdateTask,
  type TaskPatch,
} from '@/hooks';
import { useToast } from '@/ui/components/Toast';

import { snoozeToTomorrow } from './schedule';

export type TaskActions = {
  toggle: (task: Task) => void;
  snooze: (task: Task) => void;
  setPriority: (task: Task, priority: number) => void;
  setDue: (task: Task, dueDate: number | null) => void;
  /** Any other editable field — the detail sheet's title, notes, estimate, project. */
  setField: (task: Task, patch: TaskPatch) => void;
  remove: (task: Task, options?: { onDeleted?: () => void }) => void;
};

export function useTaskActions(
  { onOpenUnlocked }: { onOpenUnlocked?: (task: Task) => void } = {},
): TaskActions {
  const toast = useToast();
  const complete = useCompleteTask();
  const uncomplete = useUncompleteTask();
  const update = useUpdateTask();
  const remove = useDeleteTask();

  const fail = useCallback(
    (message: string, error: unknown) => {
      toast.show({ tone: 'danger', message, detail: toAppError(error).userMessage });
    },
    [toast],
  );

  /** The DAG made visible: what just became available, and a way straight to it. */
  const announceUnlocked = useCallback(
    (unlocked: Task[]) => {
      const first = unlocked[0];
      if (!first) return;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show({
        tone: 'accent',
        message:
          unlocked.length === 1
            ? 'Unlocked next step'
            : `Unlocked ${countLabel(unlocked.length, 'next step')}`,
        detail: joinNatural(unlocked.map((task) => task.title)),
        durationMs: 5000,
        action: onOpenUnlocked ? { label: 'Open', onPress: () => onOpenUnlocked(first) } : undefined,
      });
    },
    [onOpenUnlocked, toast],
  );

  return useMemo<TaskActions>(
    () => ({
      toggle: (task) => {
        if (task.isCompleted === true) {
          uncomplete.mutate(task.id, {
            onSuccess: (result) => {
              if (result.relocked.length === 0) return;
              toast.show({
                tone: 'warning',
                message: `Blocked again: ${countLabel(result.relocked.length, 'task')}`,
                detail: joinNatural(result.relocked.map((t) => t.title)),
              });
            },
            onError: (error) => fail('Could not reopen that', error),
          });
          return;
        }
        complete.mutate(task.id, {
          onSuccess: (result) => announceUnlocked(result.unlocked),
          onError: (error) => fail('Could not complete that', error),
        });
      },

      snooze: (task) => {
        update.mutate(
          { id: task.id, patch: { dueDate: snoozeToTomorrow(task.dueDate) } },
          {
            onSuccess: () => toast.show({ message: 'Snoozed to tomorrow', detail: task.title }),
            onError: (error) => fail('Could not snooze that', error),
          },
        );
      },

      setPriority: (task, priority) => {
        update.mutate(
          { id: task.id, patch: { priority } },
          { onError: (error) => fail('Could not change priority', error) },
        );
      },

      setDue: (task, dueDate) => {
        update.mutate(
          { id: task.id, patch: { dueDate } },
          { onError: (error) => fail('Could not change the due date', error) },
        );
      },

      setField: (task, patch) => {
        update.mutate(
          { id: task.id, patch },
          { onError: (error) => fail('Could not save that change', error) },
        );
      },

      remove: (task, options) => {
        remove.mutate(task.id, {
          onSuccess: (result) => {
            options?.onDeleted?.();
            toast.show({
              tone: 'neutral',
              message: 'Task deleted',
              detail:
                result.unlocked.length > 0
                  ? `${task.title} — unlocked ${joinNatural(result.unlocked.map((t) => t.title))}`
                  : task.title,
            });
          },
          onError: (error) => fail('Could not delete that', error),
        });
      },
    }),
    [announceUnlocked, complete, fail, remove, toast, uncomplete, update],
  );
}
