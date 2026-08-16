import { ScrollView, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { Chip } from '@/ui/components';
import { REFLOW_MS } from '@/ui/motion';
import { useStaggeredEntry } from '@/ui/motionHooks';
import { useTheme } from '@/ui/ThemeProvider';
import { colorForTag } from '@/ui/theme';
import type { TagCount } from '@/repositories/notes';

/**
 * The only filter the notes list offers. Tags carry a stable colour so the
 * strip is scannable without reading it; the count is what tells the user which
 * tag is worth opening.
 */
export function TagStrip({
  tags,
  selected,
  onSelect,
  total,
}: {
  tags: TagCount[];
  selected: string | null;
  onSelect: (tag: string | null) => void;
  total: number;
}) {
  const { colors, spacing } = useTheme();
  // Fading in place, not rising: a horizontal strip that slides up from below
  // has every chip cross whatever sits under it. Same call as `HabitStrip`.
  const arrive = useStaggeredEntry();
  if (tags.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      // Bleeds past the screen's gutter so the strip reads as scrollable
      // instead of as a row that happens to be clipped.
      style={{ marginHorizontal: -spacing.lg, flexGrow: 0 }}
      contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.xs }}
    >
      <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: spacing.xs }}>
        {/* "All" is the first step of the same wave, not a fixture the tags
            arrive around — it is a tab like the rest of them. */}
        <Animated.View entering={arrive(0)}>
          <Chip
            label={`All ${total}`}
            color={colors.textSecondary}
            selected={selected === null}
            onPress={() => onSelect(null)}
          />
        </Animated.View>
        {tags.map((tag, index) => (
          // Tagging a note adds a chip mid-strip and untagging the last one
          // takes it away; `layout` slides the neighbours over instead of
          // re-cutting the whole row between two frames.
          <Animated.View
            key={tag.tag}
            entering={arrive(index + 1)}
            layout={LinearTransition.duration(REFLOW_MS)}
          >
            <Chip
              label={`${tag.tag} ${tag.count}`}
              color={colorForTag(tag.tag)}
              selected={selected !== null && selected.toLowerCase() === tag.tag.toLowerCase()}
              onPress={() => onSelect(selected === tag.tag ? null : tag.tag)}
            />
          </Animated.View>
        ))}
      </View>
    </ScrollView>
  );
}
