/**
 * One line of a project.
 *
 * Two shapes, one row height: a checkbox item is a tick target, everything else
 * (idea, question, milestone, link, note) is a typed line with a leading icon.
 * Both carry the same trailing menu button, so checkbox / move / delete are
 * always in the same place under the thumb.
 */
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { ProjectItem } from '@/db/schema';
import { Checkbox, Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';

import { DueChip } from './Bits';
import { ITEM_KIND_ICON, ITEM_KIND_LABEL } from './constants';

function MenuButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  // A bare 16pt glyph in a 32×44 box: nothing but the icon moves, so the travel
  // has to be deeper than the default for the press to read at all. The box
  // itself is untouched — a transform does not resize a hit target.
  const press = usePressScale({ scale: 0.86 });
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={`Actions for ${label}`}
      onPress={onPress}
      hitSlop={8}
      {...press.handlers}
      style={[
        {
          width: 32,
          height: 44,
          alignItems: 'center',
          justifyContent: 'center',
        },
        press.style,
      ]}
    >
      <Ionicons name="ellipsis-vertical" size={16} color={colors.textTertiary} />
    </AnimatedPressable>
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
  // Above the `isCheckbox` branch: the same row can flip shape when its kind is
  // edited, and a hook called in only one of the two returns changes order when
  // it does.
  const press = usePressScale({ scale: 0.98 });

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
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={`${ITEM_KIND_LABEL[item.kind]}: ${item.content}`}
      accessibilityHint="Opens item actions"
      onPress={onMenu}
      onLongPress={onMenu}
      testID={`project-item-${item.id}`}
      {...press.handlers}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: 44,
          paddingLeft: spacing.md,
          paddingRight: spacing.xs,
          paddingVertical: spacing.sm,
        },
        press.style,
      ]}
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
    </AnimatedPressable>
  );
}
