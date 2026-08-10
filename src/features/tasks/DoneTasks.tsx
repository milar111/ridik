import { useMemo } from 'react';
import { View } from 'react-native';

import { formatDayHeading, localDateOf } from '@/core/time';
import type { Task } from '@/db/schema';
import { Badge, EmptyState } from '@/ui/components/Controls';
import { Section } from '@/ui/components/Screen';
import { useTheme } from '@/ui/ThemeProvider';

import { RowCard, TaskRow } from './TaskRow';
import type { TaskListProps } from './ActiveTasks';

type DayGroup = { key: string; label: string; tasks: Task[] };

/**
 * Enough history to be useful, few enough rows to stay a list rather than an
 * archive. It is applied *after* the completion sort, never as a SQL `limit`:
 * the repository orders by due date, so a limit there keeps the oldest-dated
 * rows and a task finished this morning falls out of its own Done list.
 */
const DONE_LIMIT = 150;

/**
 * Finished work, newest first, grouped by the day it was finished.
 *
 * The list arrives ordered by due date — useless here — so it is re-sorted on
 * completion time; rows completed before that column existed fall to the end
 * rather than pretending to be from the epoch.
 */
export function DoneTasks({ tasks, projectNames, onToggle, onOpen, onQuickActions }: TaskListProps) {
  const { spacing } = useTheme();
  const groups = useMemo(() => groupByCompletionDay(tasks), [tasks]);

  if (groups.length === 0) {
    return (
      <EmptyState
        icon="archive-outline"
        title="Nothing completed yet"
        hint="Tick a task, or say “mark the servo order as done”"
      />
    );
  }

  return (
    <View style={{ gap: spacing.lg }}>
      {groups.map((group) => (
        <Section
          key={group.key}
          compact
          title={group.label}
          right={<Badge label={String(group.tasks.length)} tone="success" />}
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

function groupByCompletionDay(tasks: readonly Task[]): DayGroup[] {
  const sorted = [...tasks]
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    .slice(0, DONE_LIMIT);
  const groups: DayGroup[] = [];
  const index = new Map<string, DayGroup>();

  for (const task of sorted) {
    const key = task.completedAt == null ? 'undated' : localDateOf(task.completedAt);
    let group = index.get(key);
    if (!group) {
      group = {
        key,
        label: task.completedAt == null ? 'Earlier' : formatDayHeading(task.completedAt),
        tasks: [],
      };
      index.set(key, group);
      groups.push(group);
    }
    group.tasks.push(task);
  }
  return groups;
}
