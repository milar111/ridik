import type { ReactNode } from 'react';
import { Fragment } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { formatDuration } from '@/core/time';
import type { Task } from '@/db/schema';
import { Card, Divider } from '@/ui/components/Card';
import { Txt } from '@/ui/components/Text';
import { inkOn } from '@/ui/ink';
import { REFLOW_MS } from '@/ui/motion';
import { useStaggeredEntry , AnimatedPressable, useCheckPop, usePressScale } from '@/ui/motionHooks';
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
  // The row's press used to be a background flash. A flash and a scale together
  // is two answers to one finger, so the flash goes and the row sinks instead.
  const rowPress = usePressScale({ scale: 0.98 });
  const boxPress = usePressScale({ scale: 0.88 });
  // Completing a task is one of the two things this app is for. It used to pop
  // the tick, fill the box and strike the title in a single frame.
  const pop = useCheckPop(done);

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
    <AnimatedPressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={task.title}
      accessibilityHint="Opens the task. Long press for quick actions."
      onPress={() => onOpen(task)}
      onLongPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        onQuickActions(task);
      }}
      {...rowPress.handlers}
      style={[styles.row, { paddingRight: spacing.md }, rowPress.style]}
    >
      <View
        style={[
          styles.priorityBar,
          // Colour is state: only the one priority that changes what you do next.
          { backgroundColor: task.priority === 1 && !done ? colors.accent : 'transparent' },
        ]}
      />

      <AnimatedPressable
        testID={testID ? `${testID}-box` : undefined}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
        accessibilityLabel={`${done ? 'Reopen' : 'Complete'} ${task.title}`}
        // The target stays 41×52 — a transform does not move the layout box the
        // slop is measured from, so nothing here is harder to hit than it was.
        hitSlop={8}
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          onToggle(task);
        }}
        {...boxPress.handlers}
        style={[styles.boxTarget, boxPress.style]}
      >
        <Animated.View
          style={[
            styles.box,
            { borderColor: boxColor, backgroundColor: done ? colors.success : 'transparent' },
            pop,
          ]}
        >
          {done ? <Ionicons name="checkmark" size={13} color={inkOn(colors.success)} /> : null}
          {locked ? <Ionicons name="lock-closed" size={10} color={colors.textTertiary} /> : null}
        </Animated.View>
      </AnimatedPressable>

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
    </AnimatedPressable>
  );
}

/**
 * Rows in one hairline-bounded card, dividers inset to the text column.
 *
 * The one place the three task lists share, so the arrival is written here
 * rather than three times: Active, Blocked and Done all render their rows
 * through this, and animating it once is what keeps them identical.
 *
 * The divider moved inside the wrapper on purpose. It belongs to the row below
 * it, and a hairline left outside would stay put while its row reflowed —
 * ticking a task off would leave a stray line behind for the length of the
 * transition.
 */
export function RowCard({ rows }: { rows: { key: string; node: ReactNode }[] }) {
  const arrive = useStaggeredEntry({ from: 'below' });

  return (
    <Card padded={false}>
      {rows.map((row, i) => (
        <Animated.View
          key={row.key}
          entering={arrive(i)}
          // Completing a task takes its row out of this card mid-list. Without
          // this the rows below jump up a row-height in one frame, which reads
          // as the wrong thing having been ticked.
          layout={LinearTransition.duration(REFLOW_MS)}
        >
          {i > 0 ? <Divider inset={44} /> : null}
          {row.node}
        </Animated.View>
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
