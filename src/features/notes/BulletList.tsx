import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Actions for ${bullet.content}`}
            accessibilityState={{ expanded: open }}
            hitSlop={10}
            onPress={() => setActionsFor(open ? null : bullet.id)}
          >
            <Ionicons
              name="ellipsis-horizontal"
              size={16}
              color={open ? colors.accent : colors.textTertiary}
            />
          </Pressable>
        );

        return (
          <View key={bullet.id}>
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
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={bullet.content}
                accessibilityHint="Tap to edit"
                onPress={() => startEdit(bullet)}
                onLongPress={() => setActionsFor(open ? null : bullet.id)}
                style={({ pressed }) => [
                  styles.textRow,
                  { paddingVertical: spacing.sm, opacity: pressed ? 0.6 : 1 },
                ]}
              >
                <Txt variant="body" tone="tertiary" style={styles.dot}>
                  •
                </Txt>
                <Txt variant="body" style={{ flex: 1 }}>
                  {bullet.content}
                </Txt>
                {more}
              </Pressable>
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
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  textRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  dot: { width: 21, textAlign: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', paddingLeft: 31 },
});
