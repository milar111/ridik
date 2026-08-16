import { StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { Task } from '@/db/schema';
import { Card, Divider } from '@/ui/components/Card';
import { Txt } from '@/ui/components/Text';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';

import { dueLabel } from './buckets';
import { Sheet } from './Sheet';
import type { TaskActions } from './useTaskActions';

/**
 * The long-press menu: complete, snooze, open details.
 *
 * Nothing here edits the task. Priority and delete live in the detail sheet,
 * one tap further on, where a change is visible next to what it changed.
 */
export function QuickActions({
  task,
  actions,
  onClose,
  onOpenDetail,
}: {
  task: Task | null;
  actions: TaskActions;
  onClose: () => void;
  onOpenDetail: (task: Task) => void;
}) {
  const { colors } = useTheme();

  if (!task) return null;
  const done = task.isCompleted === true;

  const run = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <Sheet
      visible
      onClose={onClose}
      scroll={false}
      title={task.title}
      subtitle={task.dueDate != null ? `Due ${dueLabel(task.dueDate)}` : 'No due date'}
    >
      <Card padded={false}>
        <ActionRow
          icon={done ? 'arrow-undo-outline' : 'checkmark-circle-outline'}
          label={done ? 'Reopen' : 'Complete'}
          tint={done ? colors.textSecondary : colors.success}
          onPress={() => run(() => actions.toggle(task))}
        />
        <Divider inset={44} />
        <ActionRow
          icon="moon-outline"
          label="Snooze to tomorrow"
          tint={colors.warning}
          onPress={() => run(() => actions.snooze(task))}
        />
        <Divider inset={44} />
        <ActionRow
          icon="information-circle-outline"
          label="Open details"
          tint={colors.accent}
          onPress={() => run(() => onOpenDetail(task))}
        />
      </Card>
    </Sheet>
  );
}

function ActionRow({
  icon,
  label,
  tint,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  tint: string;
  onPress: () => void;
}) {
  // These rows live in a `Modal`, where a shared value driven from an effect is
  // the only mechanism that reliably animates — which is what `usePressScale`
  // is. Nothing here uses `entering`/`exiting`.
  const press = usePressScale({ scale: 0.98 });
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      {...press.handlers}
      style={[styles.action, press.style]}
    >
      <Ionicons name={icon} size={19} color={tint} />
      <Txt variant="body">{label}</Txt>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 13,
  },
});
