import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { Task } from '@/db/schema';
import { Card, Divider } from '@/ui/components/Card';
import { Chip } from '@/ui/components/Controls';
import { Txt } from '@/ui/components/Text';
import { useTheme } from '@/ui/ThemeProvider';

import { PRIORITY_LABEL, dueLabel } from './buckets';
import { Sheet } from './Sheet';
import type { TaskActions } from './useTaskActions';

/**
 * The long-press menu: the four things worth doing without opening anything.
 *
 * Priority is a chip row rather than a submenu — three values, one tap, and the
 * current one is visible while you choose.
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
  const { colors, spacing } = useTheme();
  const [confirmDelete, setConfirmDelete] = useState(false);

  // A new row must never inherit the previous row's armed delete.
  useEffect(() => setConfirmDelete(false), [task?.id]);

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
        <Divider inset={44} />
        <ActionRow
          icon="trash-outline"
          label={confirmDelete ? 'Tap again to delete' : 'Delete'}
          tint={colors.danger}
          danger
          onPress={() => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            run(() => actions.remove(task));
          }}
        />
      </Card>

      <View style={{ gap: spacing.sm }}>
        <Txt variant="micro" tone="tertiary" style={{ letterSpacing: 0.8 }}>
          PRIORITY
        </Txt>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          {[1, 2, 3].map((level) => (
            <Chip
              key={level}
              label={PRIORITY_LABEL[level] ?? String(level)}
              selected={task.priority === level}
              color={level === 1 ? colors.accent : colors.textSecondary}
              onPress={() => actions.setPriority(task, level)}
            />
          ))}
        </View>
      </View>
    </Sheet>
  );
}

function ActionRow({
  icon,
  label,
  tint,
  danger,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  tint: string;
  danger?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: pressed ? colors.surfaceSunken : 'transparent' },
      ]}
    >
      <Ionicons name={icon} size={19} color={tint} />
      <Txt variant="body" style={danger ? { color: colors.danger } : undefined}>
        {label}
      </Txt>
    </Pressable>
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
