/**
 * One line of a project.
 *
 * Two shapes, one row height: a checkbox item is a tick target, everything else
 * (idea, question, milestone, link, note) is a typed line with a leading icon.
 * Both carry the same trailing menu button, so checkbox / move / delete are
 * always in the same place under the thumb.
 */
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { ProjectItem } from '@/db/schema';
import { Checkbox, Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';

import { DueChip } from './Bits';
import { ITEM_KIND_ICON, ITEM_KIND_LABEL } from './constants';

function MenuButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Actions for ${label}`}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        width: 32,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.5 : 1,
      })}
    >
      <Ionicons name="ellipsis-vertical" size={16} color={colors.textTertiary} />
    </Pressable>
  );
}

export function ProjectItemRow({
  item,
  onToggle,
  onMenu,
}: {
  item: ProjectItem;
  onToggle: (next: boolean) => void;
  onMenu: () => void;
}) {
  const { colors, spacing } = useTheme();

  const trailing = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
      {item.dueDate == null ? null : <DueChip dueDate={item.dueDate} muted={item.isCompleted} />}
      <MenuButton label={item.content} onPress={onMenu} />
    </View>
  );

  if (item.isCheckbox) {
    return (
      <View style={{ paddingLeft: spacing.md, paddingRight: spacing.xs }}>
        <Checkbox
          checked={item.isCompleted}
          onToggle={onToggle}
          label={item.content}
          sublabel={item.detail ?? undefined}
          right={trailing}
          testID={`project-item-${item.id}`}
        />
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${ITEM_KIND_LABEL[item.kind]}: ${item.content}`}
      accessibilityHint="Opens item actions"
      onPress={onMenu}
      onLongPress={onMenu}
      testID={`project-item-${item.id}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 44,
        paddingLeft: spacing.md,
        paddingRight: spacing.xs,
        paddingVertical: spacing.sm,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name={ITEM_KIND_ICON[item.kind]} size={16} color={colors.textTertiary} />
      <View style={{ flex: 1, gap: 1 }}>
        <Txt variant="body">{item.content}</Txt>
        {item.detail ? (
          <Txt variant="caption" tone="tertiary">
            {item.detail}
          </Txt>
        ) : null}
      </View>
      {trailing}
    </Pressable>
  );
}
