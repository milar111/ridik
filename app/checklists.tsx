import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { countLabel } from '@/core/format';
import {
  ChecklistSection,
  ErrorRow,
  NewListDialog,
  SkeletonRows,
  errorMessage,
} from '@/features/notes';
import { useChecklistNames } from '@/hooks';
import { Button, Divider, EmptyState, Screen, Txt } from '@/ui/components';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';

/** Leaves the section's header just clear of the top edge after a jump. */
const JUMP_MARGIN = 8;

/**
 * Every list, every row, all open.
 *
 * The Notes tab collapses lists so they do not bury each other; here the whole
 * inventory is the point — you open this screen standing in a shop. `?list=`
 * scrolls to one of them, which is how a voice result deep-links into it.
 */
export default function ChecklistsScreen() {
  const { list } = useLocalSearchParams<{ list?: string }>();
  const router = useRouter();
  const { colors, spacing } = useTheme();

  const names = useChecklistNames();
  const [creating, setCreating] = useState(false);

  const scroller = useRef<ScrollView>(null);
  const offsets = useRef(new Map<string, number>());
  /** The list we still owe a jump to, consumed by the first layout that matches. */
  const target = useRef<string | null>(null);

  const lists = names.data ?? [];
  const stillOpen = lists.reduce((sum, entry) => sum + entry.open, 0);

  const scrollTo = (y: number) =>
    scroller.current?.scrollTo({ y: Math.max(0, y - JUMP_MARGIN), animated: true });

  /**
   * A section's own `onLayout` is the only honest source for its offset: how
   * tall it is depends on how many rows it has, which is not known until it has
   * rendered. Requests are therefore parked and claimed by the layout pass.
   */
  const claimLayout = (name: string, y: number) => {
    offsets.current.set(name.toLowerCase(), y);
    const wanted = target.current;
    if (!wanted || wanted.toLowerCase() !== name.toLowerCase()) return;
    target.current = null;
    scrollTo(y);
  };

  useEffect(() => {
    if (!list) {
      target.current = null;
      return;
    }
    // Arriving at a screen that is already laid out: nothing will re-fire, so
    // the pending jump has to be resolved here instead.
    const known = offsets.current.get(list.toLowerCase());
    if (known !== undefined) {
      target.current = null;
      scrollTo(known);
      return;
    }
    target.current = list;
  }, [list]);

  return (
    <Screen scroll={false} contentStyle={{ flex: 1, gap: spacing.sm }}>
      <View style={[styles.bar, { paddingTop: spacing.sm }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
          onPress={() => router.back()}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>

        <View style={{ flex: 1, gap: 1 }}>
          <Txt variant="title">Lists</Txt>
          {lists.length > 0 ? (
            <Txt variant="caption" tone="tertiary">
              {countLabel(lists.length, 'list')} · {stillOpen} still open
            </Txt>
          ) : null}
        </View>

        <Button
          label="New list"
          icon="add"
          size="sm"
          variant="primary"
          onPress={() => setCreating(true)}
        />
      </View>

      <ErrorBoundary label="checklists">
        {names.isPending ? <SkeletonRows count={6} height={44} /> : null}

        {names.error ? (
          <ErrorRow
            message={errorMessage(names.error, 'I could not read your lists.')}
            onRetry={() => void names.refetch()}
          />
        ) : null}

        {!names.isPending && !names.error ? (
          <ScrollView
            ref={scroller}
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={{ paddingBottom: spacing.xxl }}
            showsVerticalScrollIndicator={false}
          >
            {lists.length === 0 ? (
              <EmptyState
                icon="list-outline"
                title="No lists yet"
                hint="Try: “add M3 screws and 20mm standoffs to my hardware list”"
              />
            ) : null}

            {lists.map((summary, index) => (
              <View key={summary.name}>
                {index > 0 ? <Divider /> : null}
                <ChecklistSection
                  summary={summary}
                  expanded
                  onLayout={(event) => claimLayout(summary.name, event.nativeEvent.layout.y)}
                />
              </View>
            ))}

            {lists.length > 0 ? (
              <Txt variant="micro" tone="tertiary" center style={{ paddingTop: spacing.lg }}>
                Ticking an item off is instant — it saves in the background.
              </Txt>
            ) : null}
          </ScrollView>
        ) : null}
      </ErrorBoundary>

      <NewListDialog
        visible={creating}
        onClose={() => setCreating(false)}
        // The new section has not laid out yet; parking the name here makes the
        // layout pass that creates it do the scrolling.
        onCreated={(name) => {
          target.current = name;
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: 44 },
});
