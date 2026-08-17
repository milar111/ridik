import type { ReactNode } from 'react';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import {
  useRemoveNoteBullet,
  useReorderNoteBullets,
  useToggleNoteBullet,
  useUpdateNoteBullet,
} from '@/hooks';
import type { NoteWithBullets } from '@/repositories/notes';
import type { NoteBullet } from '@/db/schema';
import { Button, Checkbox, Input, Txt, useToast } from '@/ui/components';
import { REFLOW_MS } from '@/ui/motion';
import { useStaggeredEntry , AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import { useTheme } from '@/ui/ThemeProvider';

import { errorMessage } from './errors';

/** Icon-only buttons still have to be thumb-sized. */
const TAP = { minWidth: 44, minHeight: 40 } as const;

/**
 * The body of a note.
 *
 * Two row shapes, one list: a `todo` bullet is a checkbox whose tap ticks it
 * off — that is the action worth having on a walk — and a `text` bullet is a
 * dot whose tap opens it for editing. Everything else (reorder, delete, promote
 * a line to a todo) lives behind the row's ⋯, which keeps the resting state
 * dense and means no gesture has to be discovered.
 */
export function BulletList({ note }: { note: NoteWithBullets }) {
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const arrive = useStaggeredEntry({ from: 'below' });

  const toggleBullet = useToggleNoteBullet();
  const updateBullet = useUpdateNoteBullet();
  const removeBullet = useRemoveNoteBullet();
  const reorderBullets = useReorderNoteBullets();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [actionsFor, setActionsFor] = useState<string | null>(null);

  const bullets = note.bullets;

  const complain = (fallback: string) => (error: unknown) =>
    toast.show({ message: errorMessage(error, fallback), tone: 'danger' });

  const startEdit = (bullet: NoteBullet) => {
    setActionsFor(null);
    setDraft(bullet.content);
    setEditingId(bullet.id);
  };

  const commitEdit = (bullet: NoteBullet, value: string) => {
    setEditingId(null);
    const content = value.trim();
    // An empty bullet is refused by the repository, and "I cleared the field"
    // means "cancel" far more often than it means "delete this".
    if (!content || content === bullet.content) return;
    updateBullet.mutate(
      { bulletId: bullet.id, content },
      { onError: complain('I could not save that bullet.') },
    );
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= bullets.length) return;
    const orderedIds = bullets.map((bullet) => bullet.id);
    const [moved] = orderedIds.splice(index, 1);
    orderedIds.splice(target, 0, moved!);
    reorderBullets.mutate(
      { noteId: note.id, orderedIds },
      { onError: complain('I could not reorder those.') },
    );
  };

  return (
    <View>
      {bullets.map((bullet, index) => {
        const editing = editingId === bullet.id;
        const open = actionsFor === bullet.id;
        const isTodo = bullet.bulletKind === 'todo';

        const more = (
          <MoreButton
            label={bullet.content}
            open={open}
            tint={open ? colors.accent : colors.textTertiary}
            onPress={() => setActionsFor(open ? null : bullet.id)}
          />
        );

        return (
          // Reorder is the reason this row is animated at all: the up/down
          // buttons swap two bullets, and a swap with no travel is two rows
          // blinking into each other's place — you cannot tell which one moved.
          // `layout` makes the pair trade places in front of you, and covers the
          // gap closing when a bullet is deleted.
          <Animated.View
            key={bullet.id}
            entering={arrive(index)}
            layout={LinearTransition.duration(REFLOW_MS)}
          >
            {editing ? (
              <View style={{ paddingVertical: spacing.xs }}>
                <Input
                  autoFocus
                  value={draft}
                  onChangeText={setDraft}
                  returnKeyType="done"
                  accessibilityLabel="Edit bullet"
                  onSubmitEditing={(event) => commitEdit(bullet, event.nativeEvent.text)}
                  onBlur={() => commitEdit(bullet, draft)}
                />
              </View>
            ) : isTodo ? (
              <Checkbox
                checked={bullet.isCompleted}
                label={bullet.content}
                onToggle={(next) =>
                  toggleBullet.mutate(
                    { bulletId: bullet.id, completed: next },
                    { onError: complain('I could not tick that off.') },
                  )
                }
                right={more}
              />
            ) : (
              <TextBulletRow
                content={bullet.content}
                padding={spacing.sm}
                onPress={() => startEdit(bullet)}
                onLongPress={() => setActionsFor(open ? null : bullet.id)}
                trailing={more}
              />
            )}

            {open && !editing ? (
              <View style={[styles.actions, { gap: spacing.xs, paddingBottom: spacing.xs }]}>
                <Button
                  icon="chevron-up"
                  size="sm"
                  style={TAP}
                  accessibilityLabel="Move up"
                  disabled={index === 0}
                  onPress={() => move(index, -1)}
                />
                <Button
                  icon="chevron-down"
                  size="sm"
                  style={TAP}
                  accessibilityLabel="Move down"
                  disabled={index === bullets.length - 1}
                  onPress={() => move(index, 1)}
                />
                <Button
                  icon="create-outline"
                  size="sm"
                  style={TAP}
                  accessibilityLabel="Edit bullet"
                  onPress={() => startEdit(bullet)}
                />
                {isTodo ? null : (
                  <Button
                    icon="checkbox-outline"
                    size="sm"
                    style={TAP}
                    accessibilityLabel="Make this a todo"
                    onPress={() => {
                      setActionsFor(null);
                      // Ticking a bullet is what promotes it to a checkbox, so
                      // an explicit "not done" is the conversion.
                      toggleBullet.mutate(
                        { bulletId: bullet.id, completed: false },
                        { onError: complain('I could not convert that bullet.') },
                      );
                    }}
                  />
                )}
                <Button
                  icon="trash-outline"
                  size="sm"
                  variant="danger"
                  style={TAP}
                  accessibilityLabel="Delete bullet"
                  onPress={() => {
                    setActionsFor(null);
                    removeBullet.mutate(bullet.id, {
                      onError: complain('I could not remove that bullet.'),
                    });
                  }}
                />
                <Button
                  icon="close"
                  size="sm"
                  variant="ghost"
                  style={TAP}
                  accessibilityLabel="Close actions"
                  onPress={() => setActionsFor(null)}
                />
              </View>
            ) : null}
          </Animated.View>
        );
      })}
    </View>
  );
}

/**
 * The row's ⋯, extracted because it needs its own animation state and a hook
 * cannot be called from inside a `map`.
 *
 * It had no press feedback at all — only a colour change once the actions were
 * already open, which is the result rather than the acknowledgement. Deep
 * travel: a bare 16pt glyph has nothing but itself to move.
 */
function MoreButton({
  label,
  open,
  tint,
  onPress,
}: {
  label: string;
  open: boolean;
  tint: string;
  onPress: () => void;
}) {
  const press = usePressScale({ scale: 0.82 });
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={`Actions for ${label}`}
      accessibilityState={{ expanded: open }}
      hitSlop={10}
      onPress={onPress}
      {...press.handlers}
      style={press.style}
    >
      <Ionicons name="ellipsis-horizontal" size={16} color={tint} />
    </AnimatedPressable>
  );
}

/**
 * A `text` bullet, extracted for the same reason as `MoreButton`.
 *
 * The ⋯ sits *inside* this row, so the row's scale carries it: two nested
 * transforms compose, and a press on the ⋯ reads as the glyph sinking further
 * than the line it belongs to, which is what actually happened.
 */
function TextBulletRow({
  content,
  padding,
  onPress,
  onLongPress,
  trailing,
}: {
  content: string;
  padding: number;
  onPress: () => void;
  onLongPress: () => void;
  trailing: ReactNode;
}) {
  const press = usePressScale({ scale: 0.98 });
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={content}
      accessibilityHint="Tap to edit"
      onPress={onPress}
      onLongPress={onLongPress}
      {...press.handlers}
      style={[styles.textRow, { paddingVertical: padding }, press.style]}
    >
      <Txt variant="body" tone="tertiary" style={styles.dot}>
        •
      </Txt>
      <Txt variant="body" style={{ flex: 1 }}>
        {content}
      </Txt>
      {trailing}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  textRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  dot: { width: 21, textAlign: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', paddingLeft: 31 },
});
