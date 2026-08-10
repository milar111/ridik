import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  useAddChecklistItems,
  useChecklistItems,
  useClearCompletedChecklistItems,
  useRemoveChecklistItem,
  useToggleChecklistItem,
} from '@/hooks';
import type { ChecklistListSummary } from '@/repositories/checklists';
import { Button, Checkbox, Divider, Input, Txt, useToast } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';

import { ErrorRow, SkeletonRows } from './Placeholders';
import { errorMessage } from './errors';

/**
 * One checklist, header plus rows.
 *
 * Shared by the Lists side of the Notes tab (collapsible, so a long list does
 * not bury the next one) and by the full Checklists screen (always open). The
 * collapsible behaviour is controlled from outside precisely so those two
 * screens can disagree about it without forking the component.
 */
export function ChecklistSection({
  summary,
  expanded,
  onToggleExpanded,
  onLayout,
}: {
  summary: ChecklistListSummary;
  expanded: boolean;
  /** Omit to make the section permanently open and its header inert. */
  onToggleExpanded?: () => void;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const { colors, spacing } = useTheme();
  const toast = useToast();

  const items = useChecklistItems(summary.name, { enabled: expanded });
  const toggleItem = useToggleChecklistItem();
  const addItems = useAddChecklistItems();
  const clearCompleted = useClearCompletedChecklistItems();
  const removeItem = useRemoveChecklistItem();

  const [draft, setDraft] = useState('');

  /**
   * The repository already returns open rows first, but an optimistic tick only
   * patches the row in place — without re-sorting here the item would stay put
   * until the refetch landed and then jump, which reads as a glitch.
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

  const header = (
    <View style={[styles.header, { paddingVertical: spacing.sm, gap: spacing.sm }]}>
      {onToggleExpanded ? (
        <Ionicons
          name={expanded ? 'chevron-down' : 'chevron-forward'}
          size={15}
          color={colors.textTertiary}
        />
      ) : (
        <Ionicons name="list-outline" size={15} color={colors.textTertiary} />
      )}
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
    <View onLayout={onLayout}>
      {onToggleExpanded ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${summary.name}, ${summary.open} of ${summary.total} open`}
          accessibilityState={{ expanded }}
          onPress={onToggleExpanded}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, minHeight: 44 })}
        >
          {header}
        </Pressable>
      ) : (
        header
      )}

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

          {rows.map((item) => (
            <Checkbox
              key={item.id}
              checked={Boolean(item.isCompleted)}
              label={item.itemText}
              onToggle={(next) =>
                toggleItem.mutate(
                  {
                    listName: summary.name,
                    // The repository only resolves items by their words; the id
                    // rides along purely so the optimistic patch cannot miss.
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
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${item.itemText}`}
                    hitSlop={12}
                    onPress={() =>
                      removeItem.mutate(item.id, {
                        onError: (error) =>
                          toast.show({
                            message: errorMessage(error, 'I could not remove that item.'),
                            tone: 'danger',
                          }),
                      })
                    }
                  >
                    <Ionicons name="close" size={15} color={colors.textTertiary} />
                  </Pressable>
                </View>
              }
            />
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

          {done > 0 ? (
            <Button
              label={`Clear ${done} done`}
              icon="trash-bin-outline"
              size="sm"
              variant="ghost"
              onPress={() =>
                clearCompleted.mutate(summary.name, {
                  onSuccess: (count) =>
                    toast.show({ message: `Cleared ${count} from ${summary.name}` }),
                  onError: (error) =>
                    toast.show({
                      message: errorMessage(error, 'I could not clear those.'),
                      tone: 'danger',
                    }),
                })
              }
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center' },
  count: { fontVariant: ['tabular-nums'] },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  footer: { flexDirection: 'row', alignItems: 'flex-end' },
});
