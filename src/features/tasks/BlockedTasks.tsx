import { View } from 'react-native';

import { truncate } from '@/core/format';
import type { Task } from '@/db/schema';
import { Badge, Chip, EmptyState } from '@/ui/components/Controls';
import { Section } from '@/ui/components/Screen';
import { Txt } from '@/ui/components/Text';
import { useTheme } from '@/ui/ThemeProvider';

import { RowCard, TaskRow } from './TaskRow';
import type { TaskListHandlers } from './ActiveTasks';

export type BlockedTasksProps = TaskListHandlers & {
  tasks: readonly Task[];
  blockers: ReadonlyMap<string, Task[]>;
  projectNames: ReadonlyMap<string, string>;
};

/**
 * What is waiting, and on what.
 *
 * The chain has to be legible without opening anything: each blocker is a chip
 * carrying its own completion state, so "two of three done" is a glance rather
 * than a tap.
 */
export function BlockedTasks({
  tasks,
  blockers,
  projectNames,
  onToggle,
  onOpen,
  onQuickActions,
}: BlockedTasksProps) {
  if (tasks.length === 0) {
    return (
      <EmptyState
        icon="lock-open-outline"
        title="Nothing is blocked"
        hint="Try: “I need to 3D print the frame and order the servos before I can assemble the robot”"
      />
    );
  }

  return (
    <Section compact title="Waiting on something" right={<Badge label={String(tasks.length)} tone="neutral" />}>
      <RowCard
        rows={tasks.map((task) => ({
          key: task.id,
          node: (
            <TaskRow
              task={task}
              testID={`task-${task.id}`}
              projectName={task.projectId ? projectNames.get(task.projectId) : null}
              onToggle={onToggle}
              onOpen={onOpen}
              onQuickActions={onQuickActions}
              below={<BlockerChips blockers={blockers.get(task.id) ?? []} />}
            />
          ),
        }))}
      />
    </Section>
  );
}

function BlockerChips({ blockers }: { blockers: readonly Task[] }) {
  const { colors } = useTheme();
  if (blockers.length === 0) {
    return (
      <Txt variant="micro" tone="tertiary">
        Waiting on something that no longer exists — reopen it to unblock.
      </Txt>
    );
  }

  const done = blockers.filter((task) => task.isCompleted === true).length;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 3 }}>
      <Txt variant="micro" tone="tertiary">
        Waiting on:
      </Txt>
      {blockers.map((blocker) => {
        const complete = blocker.isCompleted === true;
        return (
          <Chip
            key={blocker.id}
            size="sm"
            label={truncate(blocker.title, 24)}
            icon={complete ? 'checkmark' : 'ellipse-outline'}
            color={complete ? colors.success : colors.warning}
          />
        );
      })}
      {blockers.length > 1 ? (
        <Txt variant="micro" tone="tertiary">
          {done}/{blockers.length} done
        </Txt>
      ) : null}
    </View>
  );
}
