import { ScrollView, View } from 'react-native';

import { Chip } from '@/ui/components';
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
        <Chip
          label={`All ${total}`}
          color={colors.textSecondary}
          selected={selected === null}
          onPress={() => onSelect(null)}
        />
        {tags.map((tag) => (
          <Chip
            key={tag.tag}
            label={`${tag.tag} ${tag.count}`}
            color={colorForTag(tag.tag)}
            selected={selected !== null && selected.toLowerCase() === tag.tag.toLowerCase()}
            onPress={() => onSelect(selected === tag.tag ? null : tag.tag)}
          />
        ))}
      </View>
    </ScrollView>
  );
}
