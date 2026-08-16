/**
 * Everything filed *against* this project that lives somewhere else.
 *
 * A task said into the Tasks tab and a receipt said into the ledger both belong
 * to the trip; this panel is where they surface, and every row leads back to
 * the screen that owns it rather than editing it in place.
 */
import { View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { countLabel, formatMoney } from '@/core/format';
import { formatDayHeading } from '@/core/time';
import type { ProjectOverview } from '@/repositories/projects';
import { Card, Chip, Divider, EmptyState, Section, Txt } from '@/ui/components';
import { REFLOW_MS } from '@/ui/motion';
import { useStaggeredEntry } from '@/ui/motionHooks';
import { colorForTag } from '@/ui/theme';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';

import { DueChip } from './Bits';
import type { IconName } from './constants';
import { currencyTotals } from './format';

function LinkRow({
  icon,
  iconColor,
  title,
  subtitle,
  right,
  onPress,
  struck,
}: {
  icon: IconName;
  iconColor?: string;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onPress: () => void;
  struck?: boolean;
}) {
  const { colors, spacing } = useTheme();
  const press = usePressScale({ scale: 0.98 });
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint="Opens it on its own screen"
      onPress={onPress}
      {...press.handlers}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: 44,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
        },
        press.style,
      ]}
    >
      <Ionicons name={icon} size={16} color={iconColor ?? colors.textTertiary} />
      <View style={{ flex: 1, gap: 1 }}>
        <Txt
          variant="body"
          tone={struck ? 'tertiary' : 'primary'}
          numberOfLines={1}
          style={struck ? { textDecorationLine: 'line-through' } : undefined}
        >
          {title}
        </Txt>
        {subtitle ? (
          <Txt variant="caption" tone="tertiary" numberOfLines={1}>
            {subtitle}
          </Txt>
        ) : null}
      </View>
      {right}
      <Ionicons name="chevron-forward" size={14} color={colors.textTertiary} />
    </AnimatedPressable>
  );
}

/**
 * Hairline-separated rows in one card; each child keeps the key it was given.
 *
 * Four of the five groups on this panel render through here, so the arrival is
 * written once — the same reasoning as `RowCard` on the task lists. Each card
 * runs its own wave from zero rather than one wave down the whole panel: the
 * groups are separate cards under separate headings, and a single count across
 * all of them would leave Spending waiting on Tasks for no visible reason.
 */
function Group({ children }: { children: React.ReactElement[] }) {
  const arrive = useStaggeredEntry({ from: 'below' });

  return (
    <Card padded={false}>
      {children.map((child, index) => (
        <Animated.View
          key={child.key ?? index}
          entering={arrive(index)}
          // Ticking a linked task off elsewhere drops it out of this card on
          // the next refetch; the rows below close the gap rather than jump.
          layout={LinearTransition.duration(REFLOW_MS)}
        >
          {index > 0 ? <Divider inset={12} /> : null}
          {child}
        </Animated.View>
      ))}
    </Card>
  );
}

export function LinkedPanel({
  linked,
  onOpen,
}: {
  linked: ProjectOverview['linked'];
  onOpen: (href: string) => void;
}) {
  const { colors, spacing } = useTheme();
  // Money is the one group that does not go through `Group` — its rows are two
  // lines and a wallet rather than a `LinkRow` — so it arrives on its own copy
  // of the same wave.
  const arriveTotal = useStaggeredEntry({ from: 'below' });
  const totals = currencyTotals(linked.transactions);
  const empty =
    linked.tasks.length === 0 &&
    linked.notes.length === 0 &&
    linked.checklists.length === 0 &&
    linked.transactions.length === 0;

  if (empty) {
    return (
      <EmptyState
        icon="link-outline"
        title="Nothing filed against this project yet"
        hint="Try: 'add a task to book the flights for my Japan trip' or 'I spent 40 euros on the Japan trip'"
      />
    );
  }

  return (
    <View style={{ gap: spacing.lg }}>
      {totals.length > 0 ? (
        <Section title="Money">
          <Card padded={false}>
            {totals.map((total, index) => (
              <Animated.View
                key={total.currency}
                entering={arriveTotal(index)}
                layout={LinearTransition.duration(REFLOW_MS)}
              >
                {index > 0 ? <Divider inset={12} /> : null}
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.sm,
                    paddingHorizontal: spacing.md,
                    paddingVertical: spacing.sm + 2,
                  }}
                >
                  <Ionicons name="wallet-outline" size={16} color={colors.textTertiary} />
                  <View style={{ flex: 1, gap: 1 }}>
                    <Txt variant="bodyStrong" tone={total.net < 0 ? 'primary' : 'success'}>
                      {total.formattedNet}
                    </Txt>
                    <Txt variant="caption" tone="tertiary">
                      {formatMoney(total.spent, total.currency)} out
                      {total.received > 0
                        ? ` · ${formatMoney(total.received, total.currency)} in`
                        : ''}
                      {` · ${countLabel(
                        linked.transactions.filter((row) => row.currency === total.currency).length,
                        'entry',
                        'entries',
                      )}`}
                    </Txt>
                  </View>
                </View>
              </Animated.View>
            ))}
          </Card>
        </Section>
      ) : null}

      {linked.tasks.length > 0 ? (
        <Section title={`Tasks · ${linked.tasks.length}`}>
          <Group>
            {linked.tasks.map((task) => (
              <LinkRow
                key={task.id}
                icon={task.isCompleted ? 'checkmark-circle' : task.isLocked ? 'lock-closed-outline' : 'ellipse-outline'}
                iconColor={task.isCompleted ? colors.success : task.isLocked ? colors.warning : undefined}
                title={task.title}
                struck={!!task.isCompleted}
                right={
                  task.dueDate == null ? undefined : (
                    <DueChip dueDate={task.dueDate} muted={!!task.isCompleted} />
                  )
                }
                onPress={() => onOpen('/tasks')}
              />
            ))}
          </Group>
        </Section>
      ) : null}

      {linked.notes.length > 0 ? (
        <Section title={`Notes · ${linked.notes.length}`}>
          <Group>
            {linked.notes.map((note) => (
              <LinkRow
                key={note.id}
                icon={note.isPinned ? 'bookmark' : 'document-text-outline'}
                title={note.titleSummary}
                right={
                  <Chip label={note.categoryTag} color={colorForTag(note.categoryTag)} size="sm" />
                }
                onPress={() => onOpen(`/note/${note.id}`)}
              />
            ))}
          </Group>
        </Section>
      ) : null}

      {linked.checklists.length > 0 ? (
        <Section title={`Checklist items · ${linked.checklists.length}`}>
          <Group>
            {linked.checklists.map((row) => (
              <LinkRow
                key={row.id}
                icon={row.isCompleted ? 'checkmark-circle' : 'square-outline'}
                iconColor={row.isCompleted ? colors.success : undefined}
                title={row.quantity ? `${row.itemText} ×${row.quantity}` : row.itemText}
                subtitle={row.listName}
                struck={!!row.isCompleted}
                onPress={() =>
                  onOpen(`/notes?pane=lists&list=${encodeURIComponent(row.listName)}`)
                }
              />
            ))}
          </Group>
        </Section>
      ) : null}

      {linked.transactions.length > 0 ? (
        <Section title={`Spending · ${linked.transactions.length}`}>
          <Group>
            {linked.transactions.map((row) => (
              <LinkRow
                key={row.id}
                icon={row.direction === 'income' ? 'arrow-down-circle-outline' : 'arrow-up-circle-outline'}
                iconColor={row.direction === 'income' ? colors.success : undefined}
                title={row.description ?? row.category}
                subtitle={`${row.category} · ${formatDayHeading(row.createdAt)}`}
                right={
                  <Txt variant="caption" tone={row.direction === 'income' ? 'success' : 'secondary'}>
                    {row.direction === 'income' ? '+' : '−'}
                    {formatMoney(row.amount, row.currency)}
                  </Txt>
                }
                onPress={() => onOpen('/ledger')}
              />
            ))}
          </Group>
        </Section>
      ) : null}
    </View>
  );
}
