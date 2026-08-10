import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { countLabel } from '@/core/format';
import { formatRelative } from '@/core/time';
import type { NoteWithBullets } from '@/repositories/notes';
import { Chip, Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';
import { colorForTag } from '@/ui/theme';

const PREVIEW_BULLETS = 2;

/**
 * One note, four lines at most.
 *
 * The metadata is deliberately "what is in it" and "when I last touched it" —
 * never when it was created. The user reaches for the note they keep adding to,
 * and a creation date is the one fact that never helps them find it.
 */
export function NoteRow({
  note,
  onPress,
  onLongPress,
}: {
  note: NoteWithBullets;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { colors, spacing } = useTheme();

  const todos = note.bullets.filter((bullet) => bullet.bulletKind === 'todo');
  const done = todos.filter((bullet) => bullet.isCompleted).length;
  const preview = note.bullets.slice(0, PREVIEW_BULLETS);
  const tint = colorForTag(note.categoryTag);

  const summary =
    todos.length > 0 ? `${done}/${todos.length}` : String(note.bullets.length);
  const allDone = todos.length > 0 && done === todos.length;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${note.titleSummary}, tagged ${note.categoryTag}, ${countLabel(
        note.bullets.length,
        'bullet',
      )}`}
      accessibilityHint="Long press for pin, tag, archive and delete"
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row,
        { paddingVertical: spacing.sm + 2, opacity: pressed ? 0.6 : 1 },
      ]}
    >
      <View style={styles.head}>
        {note.isPinned ? <Ionicons name="pin" size={13} color={colors.accent} /> : null}
        <Txt variant="bodyStrong" numberOfLines={1} style={{ flex: 1 }}>
          {note.titleSummary}
        </Txt>
        <Txt variant="mono" tone={allDone ? 'success' : 'tertiary'} style={styles.count}>
          {summary}
        </Txt>
      </View>

      <View style={styles.meta}>
        <Chip label={note.categoryTag} color={tint} size="sm" />
        <Txt variant="micro" tone="tertiary" numberOfLines={1}>
          {formatRelative(note.updatedAt)}
        </Txt>
        {note.isArchived ? (
          <Txt variant="micro" tone="tertiary">
            · archived
          </Txt>
        ) : null}
      </View>

      {preview.length > 0 ? (
        <View style={{ gap: 1 }}>
          {preview.map((bullet) => (
            <Txt
              key={bullet.id}
              variant="caption"
              tone={bullet.isCompleted ? 'tertiary' : 'secondary'}
              numberOfLines={1}
              style={bullet.isCompleted ? styles.struck : undefined}
            >
              {bullet.bulletKind === 'todo' ? (bullet.isCompleted ? '☑ ' : '☐ ') : '• '}
              {bullet.content}
            </Txt>
          ))}
          {note.bullets.length > PREVIEW_BULLETS ? (
            <Txt variant="micro" tone="tertiary">
              +{note.bullets.length - PREVIEW_BULLETS} more
            </Txt>
          ) : null}
        </View>
      ) : (
        <Txt variant="caption" tone="tertiary">
          Empty — say “add … to {note.titleSummary}”
        </Txt>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { gap: 3, minHeight: 44 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  count: { fontVariant: ['tabular-nums'] },
  struck: { textDecorationLine: 'line-through' },
});
