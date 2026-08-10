import { useMemo } from 'react';
import { View } from 'react-native';

import type { Task } from '@/db/schema';
import { Badge, EmptyState } from '@/ui/components/Controls';
import { Section } from '@/ui/components/Screen';
import { useTheme } from '@/ui/ThemeProvider';

import { BUCKET_LABEL, BUCKET_TONE, groupByDueBucket } from './buckets';
import { RowCard, TaskRow } from './TaskRow';

export type TaskListHandlers = {
  onToggle: (task: Task) => void;
  onOpen: (task: Task) => void;
  onQuickActions: (task: Task) => void;
};

export type TaskListProps = TaskListHandlers & {
  tasks: readonly Task[];
  projectNames: ReadonlyMap<string, string>;
};

/**
 * Active work, grouped by when it is due.
 *
 * Blocked tasks are absent on purpose — they are not actionable, and a list you
 * cannot act on is noise. They live one tab across, with their reason attached.
 */
export function ActiveTasks({
  tasks,
  projectNames,
  onToggle,
  onOpen,
  onQuickActions,
}: TaskListProps) {
  const { spacing } = useTheme();
  const groups = useMemo(() => groupByDueBucket(tasks), [tasks]);

  if (groups.length === 0) {
    return (
      <EmptyState
        icon="checkmark-done-outline"
        title="Nothing to do right now"
        hint="Try: “remind me to renew the car insurance on Friday”"
      />
    );
  }

  return (
    <View style={{ gap: spacing.lg }}>
      {groups.map((group) => (
        <Section
          key={group.bucket}
          compact
          title={BUCKET_LABEL[group.bucket]}
          right={
            <Badge label={String(group.tasks.length)} tone={BUCKET_TONE[group.bucket]} />
          }
        >
          <RowCard
            rows={group.tasks.map((task) => ({
              key: task.id,
              node: (
                <TaskRow
                  task={task}
                  testID={`task-${task.id}`}
                  projectName={task.projectId ? projectNames.get(task.projectId) : null}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  onQuickActions={onQuickActions}
                />
              ),
            }))}
          />
        </Section>
      ))}
    </View>
  );
}
