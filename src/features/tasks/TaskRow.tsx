import type { ReactNode } from 'react';
import { Fragment } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { formatDuration } from '@/core/time';
import type { Task } from '@/db/schema';
import { Card, Divider } from '@/ui/components/Card';
import { Txt } from '@/ui/components/Text';
import { useTheme } from '@/ui/ThemeProvider';

import { bucketOf, dueLabel } from './buckets';

type MetaTone = 'tertiary' | 'warning' | 'danger';
type MetaPart = { text: string; tone: MetaTone };

export type TaskRowProps = {
  task: Task;
  projectName?: string | null;
  /** Extra line under the metadata — the blocked list hangs its blockers here. */
  below?: ReactNode;
  onToggle: (task: Task) => void;
  onOpen: (task: Task) => void;
  onQuickActions: (task: Task) => void;
  testID?: string;
};

/**
 * One task, one row.
 *
 * The shared <Checkbox> is a whole-row control, and a task row needs three
 * independent targets: the box completes, the row opens the detail sheet, and a
 * long press raises quick actions. So the box is its own pressable inside a row
 * that owns press and long press — the outer pressable never sees a tap that
 * landed on the box.
 */
export function TaskRow({
  task,
  projectName,
  below,
  onToggle,
  onOpen,
  onQuickActions,
  testID,
}: TaskRowProps) {
  const { colors, spacing } = useTheme();
  const done = task.isCompleted === true;
  const locked = task.isLocked === true && !done;
  const bucket = bucketOf(task.dueDate);

  const parts: MetaPart[] = [];
  if (task.dueDate != null) {
    parts.push({
      text: dueLabel(task.dueDate),
      tone: done ? 'tertiary' : bucket === 'overdue' ? 'danger' : bucket === 'today' ? 'warning' : 'tertiary',
    });
  }
  if (projectName) parts.push({ text: projectName, tone: 'tertiary' });
  if (task.estimatedMinutes != null) {
    parts.push({ text: formatDuration(task.estimatedMinutes), tone: 'tertiary' });
  }

  const boxColor = done ? colors.success : locked ? colors.borderStrong : colors.accent;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={task.title}
      accessibilityHint="Opens the task. Long press for quick actions."
      onPress={() => onOpen(task)}
      onLongPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        onQuickActions(task);
      }}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? colors.surfaceSunken : 'transparent', paddingRight: spacing.md },
      ]}
    >
      <View
        style={[
          styles.priorityBar,
          // Colour is state: only the one priority that changes what you do next.
          { backgroundColor: task.priority === 1 && !done ? colors.accent : 'transparent' },
        ]}
      />

      <Pressable
        testID={testID ? `${testID}-box` : undefined}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
        accessibilityLabel={`${done ? 'Reopen' : 'Complete'} ${task.title}`}
        hitSlop={8}
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          onToggle(task);
        }}
        style={({ pressed }) => [styles.boxTarget, { opacity: pressed ? 0.5 : 1 }]}
      >
        <View
          style={[
            styles.box,
            { borderColor: boxColor, backgroundColor: done ? colors.success : 'transparent' },
          ]}
        >
          {done ? <Ionicons name="checkmark" size={13} color="#FFFFFF" /> : null}
          {locked ? <Ionicons name="lock-closed" size={10} color={colors.textTertiary} /> : null}
        </View>
      </Pressable>

      <View style={styles.body}>
        <Txt
          variant="body"
          numberOfLines={2}
          tone={done ? 'tertiary' : 'primary'}
          style={done ? styles.struck : undefined}
        >
          {task.title}
        </Txt>
        {parts.length > 0 ? (
          <View style={styles.meta}>
            {parts.map((part, i) => (
              <Fragment key={`${part.text}-${i}`}>
                {i > 0 ? (
                  <Txt variant="micro" tone="tertiary">
                    ·
                  </Txt>
                ) : null}
                <Txt variant="micro" tone={part.tone}>
                  {part.text}
                </Txt>
              </Fragment>
            ))}
          </View>
        ) : null}
        {below}
      </View>
    </Pressable>
  );
}

/** Rows in one hairline-bounded card, dividers inset to the text column. */
export function RowCard({ rows }: { rows: { key: string; node: ReactNode }[] }) {
  return (
    <Card padded={false}>
      {rows.map((row, i) => (
        <Fragment key={row.key}>
          {i > 0 ? <Divider inset={44} /> : null}
          {row.node}
        </Fragment>
      ))}
    </Card>
  );
}

/** Placeholder rows for a cold cache — same rhythm, so nothing jumps on arrival. */
export function TaskRowSkeleton({ count = 4 }: { count?: number }) {
  const { colors, radius } = useTheme();
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Loading tasks">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.row, { paddingRight: 12 }]}>
          <View style={styles.priorityBar} />
          <View style={styles.boxTarget}>
            <View style={[styles.box, { borderColor: colors.border }]} />
          </View>
          <View style={[styles.body, { gap: 6 }]}>
            <View
              style={{
                height: 11,
                width: `${58 + ((i * 13) % 30)}%`,
                borderRadius: radius.sm,
                backgroundColor: colors.surfaceSunken,
              }}
            />
            <View
              style={{
                height: 8,
                width: '34%',
                borderRadius: radius.sm,
                backgroundColor: colors.surfaceSunken,
              }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', minHeight: 52 },
  priorityBar: { width: 3, alignSelf: 'stretch' },
  boxTarget: { width: 41, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  box: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, gap: 2, paddingVertical: 9 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
  struck: { textDecorationLine: 'line-through' },
});
