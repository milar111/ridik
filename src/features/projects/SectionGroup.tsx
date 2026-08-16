/**
 * A collapsible group of items.
 *
 * A trip has a packing list, a to-see list and a budget; collapsing the two you
 * are not looking at is what keeps a long project readable on a phone.
 */
import { View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import type { ProjectItem } from '@/db/schema';
import { Card, Divider, Txt } from '@/ui/components';
import { REFLOW_MS } from '@/ui/motion';
import { useStaggeredEntry } from '@/ui/motionHooks';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';

import { ProjectItemRow } from './ProjectItemRow';

export function SectionGroup({
  title,
  items,
  collapsed,
  onToggleCollapsed,
  onToggleItem,
  onItemMenu,
}: {
  title: string;
  items: ProjectItem[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onToggleItem: (item: ProjectItem, next: boolean) => void;
  onItemMenu: (item: ProjectItem) => void;
}) {
  const { colors, spacing } = useTheme();
  const done = items.filter((item) => item.isCompleted).length;
  const tickable = items.filter((item) => item.isCheckbox).length;
  // Expanding a collapsed section mounts these rows, so the stagger doubles as
  // the disclosure: the card unpacks itself rather than appearing whole.
  const arrive = useStaggeredEntry({ from: 'below' });
  const press = usePressScale({ scale: 0.98 });

  return (
    <View style={{ gap: spacing.xs }}>
      <AnimatedPressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: !collapsed }}
        accessibilityHint={collapsed ? 'Expands this section' : 'Collapses this section'}
        onPress={onToggleCollapsed}
        // A section heading has to stay 32pt tall to read as a heading; the
        // slop is what makes it a 44pt target.
        hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
        {...press.handlers}
        style={[
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            minHeight: 32,
          },
          press.style,
        ]}
      >
        <Ionicons
          name={collapsed ? 'chevron-forward' : 'chevron-down'}
          size={13}
          color={colors.textTertiary}
        />
        <Txt variant="micro" tone="tertiary" style={{ letterSpacing: 0.8, flex: 1 }}>
          {title.toUpperCase()}
        </Txt>
        <Txt variant="micro" tone="tertiary">
          {tickable > 0 ? `${done}/${items.length}` : `${items.length}`}
        </Txt>
      </AnimatedPressable>

      {collapsed ? null : (
        <Card padded={false}>
          {items.length === 0 ? (
            <View style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.md }}>
              <Txt variant="caption" tone="tertiary">
                Nothing here yet.
              </Txt>
            </View>
          ) : (
            items.map((item, index) => (
              // The divider belongs to the row below it and travels with it —
              // left outside the wrapper it would hold its place while its row
              // moved, leaving a hairline stranded mid-card.
              <Animated.View
                key={item.id}
                entering={arrive(index)}
                layout={LinearTransition.duration(REFLOW_MS)}
              >
                {index > 0 ? <Divider inset={spacing.md} /> : null}
                <ProjectItemRow
                  item={item}
                  onToggle={(next) => onToggleItem(item, next)}
                  onMenu={() => onItemMenu(item)}
                />
              </Animated.View>
            ))
          )}
        </Card>
      )}
    </View>
  );
}
