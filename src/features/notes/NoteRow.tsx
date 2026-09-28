import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { countLabel } from '@/core/format';
import { formatRelative } from '@/core/time';
import type { NoteWithBullets } from '@/repositories/notes';
import { Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import { previewBullets } from './preview';

/**
 * One note, shown as completely as it fits.
 *
 * The metadata is deliberately "what is in it" and "when I last touched it" —
 * never when it was created. The user reaches for the note they keep adding to,
 * and a creation date is the one fact that never helps them find it.
 *
 * Two things changed when this stopped being a directory and started being
 * something you can read, and both were costing a line of a four-line row.
 *
 * **The preview is a line budget, not two bullets.** See `./preview`: almost
 * every note this app writes is shorter than the preview that was hiding it, so
 * a three-line note showed two lines and spent a third saying "+1 more". Now
 * "+N more" appears only when something is really being held back.
 *
 * **The tag is a word, not a `Chip`.** A chip is a control — it is what a row of
 * them looks like when one is selected — and every note wore one that did
 * nothing when tapped, in a list whose own `TagStrip` is directly above it made
 * of real ones. Worse, with a tag filter on, every visible row repeated the tag
 * the reader had just chosen. As plain text it costs 15pt instead of 24 and
 * stops competing with the filter it duplicates.
 *
 * One more, found by looking at it: **the tick was an emoji.** `\u2611` gets
 * emoji presentation on iOS, so a completed bullet drew a rounded *grey* box
 * with a white check — a different size and shape from the `\u2610` above it, so
 * the column went ragged; a true grey, which is the one colour this palette
 * says reads as a bug; and it ignored the row's tone, which made the ticked
 * item the brightest thing in the row. That is "completion recedes" broken by a
 * character: the one bullet asking nothing of anybody was the one that shouted.
 * `Ionicons` nests inside a `Text` run and wraps with it, which is how the rest
 * of this app draws a checkbox and means the marker is themed, sized and toned
 * like everything around it.
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
  const preview = previewBullets(note.bullets);

  const summary =
    todos.length > 0 ? `${done}/${todos.length}` : String(note.bullets.length);
  const allDone = todos.length > 0 && done === todos.length;
  const press = usePressScale({ scale: 0.98 });

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={`${note.titleSummary}, tagged ${note.categoryTag}, ${countLabel(
        note.bullets.length,
        'bullet',
      )}`}
      accessibilityHint="Long press for pin, tag, archive and delete"
      onPress={onPress}
      onLongPress={onLongPress}
      {...press.handlers}
      style={[styles.row, { paddingVertical: spacing.sm + 2 }, press.style]}
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

      <Txt variant="micro" tone="tertiary" numberOfLines={1}>
        {[note.categoryTag, formatRelative(note.updatedAt), note.isArchived ? 'archived' : null]
          .filter((part): part is string => part !== null && part !== '')
          .join(' · ')}
      </Txt>

      {preview.shown.length > 0 ? (
        <View style={{ gap: 1 }}>
          {preview.shown.map((bullet) => (
            <Txt
              key={bullet.id}
              variant="caption"
              tone={bullet.isCompleted ? 'tertiary' : 'secondary'}
              /* Two, matching `PREVIEW_MAX_LINES_PER_BULLET` — the budget is
                 counted on the assumption the row will actually draw them, and
                 a cap of one here would silently make every long bullet cost a
                 line it was never given. */
              numberOfLines={2}
              style={bullet.isCompleted ? styles.struck : undefined}
            >
              {bullet.bulletKind === 'todo' ? (
                <Ionicons
                  name={bullet.isCompleted ? 'checkbox-outline' : 'square-outline'}
                  size={12}
                  color={bullet.isCompleted ? colors.textTertiary : colors.textSecondary}
                />
              ) : (
                '•'
              )}
              {` ${bullet.content}`}
            </Txt>
          ))}
          {preview.hidden > 0 ? (
            <Txt variant="micro" tone="tertiary">
              +{preview.hidden} more
            </Txt>
          ) : null}
        </View>
      ) : (
        <Txt variant="caption" tone="tertiary">
          Empty — say “add … to {note.titleSummary}”
        </Txt>
      )}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  row: { gap: 3, minHeight: 44 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  count: { fontVariant: ['tabular-nums'] },
  struck: { textDecorationLine: 'line-through' },
});
