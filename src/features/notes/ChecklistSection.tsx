import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { countLabel } from '@/core/format';
import {
  useAddChecklistItems,
  useChecklistItems,
  useClearCompletedChecklistItems,
  useRemoveChecklistItem,
  useToggleChecklistItem,
} from '@/hooks';
import type { ChecklistListSummary } from '@/repositories/checklists';
import { Button, Checkbox, Divider, Input, Txt, useToast } from '@/ui/components';
import { REFLOW_MS } from '@/ui/motion';
import { useStaggeredEntry , AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import { useTheme } from '@/ui/ThemeProvider';

import { ErrorRow, SkeletonRows } from './Placeholders';
import { errorMessage } from './errors';

/**
 * One checklist, header plus rows.
 *
 * The Lists side of the Notes tab is the only door to a checklist, so this is
 * the whole surface: tick, add, remove, clear. Sections collapse because a long
 * list would otherwise bury the next one.
 */
export function ChecklistSection({
  summary,
  expanded,
  onToggleExpanded,
}: {
  summary: ChecklistListSummary;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const arrive = useStaggeredEntry({ from: 'below' });
  const headerPress = usePressScale({ scale: 0.98 });

  const items = useChecklistItems(summary.name, { enabled: expanded });
  const toggleItem = useToggleChecklistItem();
  const addItems = useAddChecklistItems();
  const clearCompleted = useClearCompletedChecklistItems();
  const removeItem = useRemoveChecklistItem();

  const [draft, setDraft] = useState('');
  /**
   * How many ticked rows the clear was armed for, or `null` for unarmed. It is
   * the count and not a flag because ticking or unticking something while the
   * confirm is up changes which rows "Clear" would delete: the arm is dropped
   * rather than left pointing at a set the user never agreed to.
   */
  const [armedFor, setArmedFor] = useState<number | null>(null);

  /**
   * The repository already returns open rows first, but an optimistic tick only
   * patches the row in place — without re-sorting here the item would stay put
   * until the refetch landed and then jump, which reads as a glitch.
   *
   * The re-sort is still the right call, and it is now the whole reason the
   * rows carry a `layout` transition: ticking an item sends it to the bottom of
   * the list, and a row that *teleports* past four others is exactly as
   * confusing as one that jumps late. Same reorder, travelled rather than cut.
   */
  const rows = useMemo(() => {
    const source = items.data ?? [];
    return [...source].sort(
      (a, b) => Number(Boolean(a.isCompleted)) - Number(Boolean(b.isCompleted)),
    );
  }, [items.data]);

  const done = rows.filter((row) => row.isCompleted).length;
  const allDone = summary.total > 0 && summary.open === 0;

  const add = (value: string) => {
    const text = value.trim();
    if (!text) return;
    setDraft('');
    addItems.mutate(
      { listName: summary.name, items: [text] },
      {
        onError: (error) =>
          toast.show({
            message: errorMessage(error, `I could not add that to ${summary.name}.`),
            tone: 'danger',
          }),
      },
    );
  };

  const clear = () =>
    clearCompleted.mutate(summary.name, {
      onSuccess: (count) => {
        setArmedFor(null);
        toast.show({ message: `Cleared ${count} from ${summary.name}` });
      },
      onError: (error) => {
        setArmedFor(null);
        toast.show({
          message: errorMessage(error, 'I could not clear those.'),
          tone: 'danger',
        });
      },
    });

  const header = (
    <View style={[styles.header, { paddingVertical: spacing.sm, gap: spacing.sm }]}>
      <Ionicons
        name={expanded ? 'chevron-down' : 'chevron-forward'}
        size={15}
        color={colors.textTertiary}
      />
      <Txt variant="bodyStrong" numberOfLines={1} style={{ flex: 1 }}>
        {summary.name}
      </Txt>
      <Txt
        variant="mono"
        tone={allDone ? 'success' : summary.open > 0 ? 'primary' : 'tertiary'}
        style={styles.count}
      >
        {summary.open}/{summary.total}
      </Txt>
    </View>
  );

  return (
    <View>
      <AnimatedPressable
        accessibilityRole="button"
        accessibilityLabel={`${summary.name}, ${summary.open} of ${summary.total} open`}
        accessibilityState={{ expanded }}
        onPress={onToggleExpanded}
        {...headerPress.handlers}
        style={[{ minHeight: 44 }, headerPress.style]}
      >
        {header}
      </AnimatedPressable>

      {expanded ? (
        <View style={{ paddingLeft: spacing.lg }}>
          <Divider />

          {items.isPending ? <SkeletonRows count={3} height={34} /> : null}

          {items.error ? (
            <ErrorRow
              message={errorMessage(items.error, 'I could not read that list.')}
              onRetry={() => void items.refetch()}
            />
          ) : null}

          {!items.isPending && !items.error && rows.length === 0 ? (
            <Txt variant="caption" tone="tertiary" style={{ paddingVertical: spacing.sm }}>
              Nothing on this list yet.
            </Txt>
          ) : null}

          {rows.map((item, index) => (
            <Animated.View
              key={item.id}
              entering={arrive(index)}
              layout={LinearTransition.duration(REFLOW_MS)}
            >
              <Checkbox
                checked={Boolean(item.isCompleted)}
                label={item.itemText}
                onToggle={(next) =>
                  toggleItem.mutate(
                    {
                      listName: summary.name,
                      // The repository only resolves items by their words; the
                      // id rides along purely so the optimistic patch cannot
                      // miss.
                      itemQuery: item.itemText,
                      completed: next,
                      itemId: item.id,
                    },
                    {
                      onError: (error) =>
                        toast.show({
                          message: errorMessage(error, 'I could not tick that off.'),
                          tone: 'danger',
                        }),
                    },
                  )
                }
                right={
                  <View style={styles.trailing}>
                    {item.quantity ? (
                      <Txt variant="micro" tone="tertiary">
                        ×{item.quantity}
                      </Txt>
                    ) : null}
                    <RemoveButton
                      label={item.itemText}
                      tint={colors.textTertiary}
                      onPress={() =>
                        removeItem.mutate(item.id, {
                          onError: (error) =>
                            toast.show({
                              message: errorMessage(error, 'I could not remove that item.'),
                              tone: 'danger',
                            }),
                        })
                      }
                    />
                  </View>
                }
              />
            </Animated.View>
          ))}

          <View style={[styles.footer, { gap: spacing.sm, paddingVertical: spacing.xs }]}>
            <Input
              containerStyle={{ flex: 1 }}
              value={draft}
              onChangeText={setDraft}
              placeholder={`Add to ${summary.name}…`}
              returnKeyType="done"
              // Keeps the field up so a run of items can be typed in one go.
              submitBehavior="submit"
              onSubmitEditing={(event) => add(event.nativeEvent.text)}
              accessibilityLabel={`Add an item to ${summary.name}`}
            />
            <Button
              icon="add"
              accessibilityLabel={`Add to ${summary.name}`}
              disabled={!draft.trim()}
              onPress={() => add(draft)}
            />
          </View>

          {done === 0 ? null : armedFor === done ? (
            // The one irreversible action on this screen, and a bulk one: the
            // rows are deleted outright, so there is nothing an undo could put
            // back with its tick, its quantity and its place still on it.
            <View style={{ gap: spacing.xs, paddingVertical: spacing.xs }}>
              <Txt variant="caption" tone="secondary">
                Delete {countLabel(done, 'ticked item')} from {summary.name}? This cannot be undone.
              </Txt>
              <View style={[styles.confirm, { gap: spacing.sm }]}>
                <Button
                  label={`Clear ${done}`}
                  icon="trash-bin-outline"
                  size="sm"
                  variant="danger"
                  loading={clearCompleted.isPending}
                  onPress={clear}
                />
                <Button
                  label="Keep"
                  size="sm"
                  variant="ghost"
                  onPress={() => setArmedFor(null)}
                />
              </View>
            </View>
          ) : (
            <Button
              label={`Clear ${done} done`}
              icon="trash-bin-outline"
              size="sm"
              variant="ghost"
              onPress={() => setArmedFor(done)}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The row's ✕, extracted because it needs its own animation state and a hook
 * cannot be called from inside a `map`.
 *
 * It had no press feedback of any kind before — the only control on this screen
 * that could not be taken back was also the only one that never acknowledged
 * the finger. Deep travel because it is a bare 15pt glyph with nothing behind
 * it to watch.
 */
function RemoveButton({
  label,
  tint,
  onPress,
}: {
  label: string;
  tint: string;
  onPress: () => void;
}) {
  const press = usePressScale({ scale: 0.82 });
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={`Remove ${label}`}
      // Deliberately a much smaller target than the 44pt row it sits in:
      // removal is the rare intent and the only one here that cannot be taken
      // back, so a thumb that misses should land on the tick, which is one tap
      // to reverse. The scale is visual — slop is measured on the layout box.
      hitSlop={4}
      onPress={onPress}
      {...press.handlers}
      style={press.style}
    >
      <Ionicons name="close" size={15} color={tint} />
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center' },
  count: { fontVariant: ['tabular-nums'] },
  // The left padding is dead space owned by the row's own checkbox, so the ✕
  // does not start where the label ends.
  trailing: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 16 },
  footer: { flexDirection: 'row', alignItems: 'flex-end' },
  confirm: { flexDirection: 'row', alignItems: 'center' },
});
