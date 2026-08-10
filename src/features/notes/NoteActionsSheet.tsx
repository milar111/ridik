import { useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useArchiveNote, useDeleteNote, useNoteTags, useUpdateNote } from '@/hooks';
import type { NoteWithBullets } from '@/repositories/notes';
import { Button, Chip, Input, Txt, useToast } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';
import { colorForTag } from '@/ui/theme';

import { ActionSheet, type SheetAction } from './ActionSheet';
import { errorMessage } from './errors';

/**
 * Everything you can do to a note without opening it.
 *
 * Shared by the list's long-press and the detail screen's overflow menu, which
 * passes its own extra entries in — one menu means one place where "delete"
 * behaves correctly.
 */
export function NoteActionsSheet({
  note,
  visible,
  onClose,
  extraActions = [],
  onDeleted,
}: {
  note: NoteWithBullets | null;
  visible: boolean;
  onClose: () => void;
  extraActions?: SheetAction[];
  onDeleted?: () => void;
}) {
  const toast = useToast();
  const updateNote = useUpdateNote();
  const archiveNote = useArchiveNote();
  const deleteNote = useDeleteNote();
  const [retagging, setRetagging] = useState(false);

  if (!note) return null;

  const pin = () => {
    const next = !note.isPinned;
    updateNote.mutate(
      { id: note.id, patch: { isPinned: next } },
      {
        onSuccess: () => toast.show({ message: next ? 'Pinned' : 'Unpinned', tone: 'success' }),
        onError: (error) =>
          toast.show({ message: errorMessage(error, 'I could not pin that note.'), tone: 'danger' }),
      },
    );
  };

  const archive = () => {
    const archived = !note.isArchived;
    archiveNote.mutate(
      { id: note.id, archived },
      {
        onSuccess: () =>
          toast.show({
            message: archived ? 'Archived' : 'Back in your notes',
            detail: archived ? note.titleSummary : undefined,
            tone: 'neutral',
            action: archived
              ? {
                  label: 'Undo',
                  onPress: () => archiveNote.mutate({ id: note.id, archived: false }),
                }
              : undefined,
          }),
        onError: (error) =>
          toast.show({
            message: errorMessage(error, 'I could not archive that note.'),
            tone: 'danger',
          }),
      },
    );
  };

  /**
   * The repository refuses to delete without `confirmed: true`, because a
   * mis-heard utterance must never destroy a note. This dialog *is* that
   * confirmation, so the flag is only ever set after the user has answered —
   * and if the repository still refuses, its own sentence is what gets shown.
   */
  const confirmDelete = () => {
    Alert.alert(
      `Delete “${note.titleSummary}”?`,
      `${note.bullets.length === 1 ? '1 bullet' : `${note.bullets.length} bullets`} will go with it. This cannot be undone.`,
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            deleteNote.mutate(
              { id: note.id, confirmed: true },
              {
                onSuccess: () => {
                  toast.show({ message: 'Note deleted', detail: note.titleSummary, tone: 'danger' });
                  onDeleted?.();
                },
                onError: (error) =>
                  toast.show({
                    message: errorMessage(error, 'I could not delete that note.'),
                    tone: 'danger',
                  }),
              },
            ),
        },
      ],
    );
  };

  const actions: SheetAction[] = [
    {
      label: note.isPinned ? 'Unpin' : 'Pin to the top',
      icon: note.isPinned ? 'pin-outline' : 'pin',
      onPress: pin,
    },
    { label: 'Change tag', icon: 'pricetag-outline', onPress: () => setRetagging(true) },
    ...extraActions,
    {
      label: note.isArchived ? 'Unarchive' : 'Archive',
      icon: note.isArchived ? 'arrow-undo-outline' : 'archive-outline',
      onPress: archive,
    },
    {
      label: 'Delete',
      icon: 'trash-outline',
      tone: 'danger',
      detail: 'Asks first — this one cannot be undone',
      onPress: confirmDelete,
    },
  ];

  return (
    <>
      <ActionSheet
        visible={visible}
        title={note.titleSummary}
        subtitle={note.categoryTag}
        actions={actions}
        onClose={onClose}
      />
      <ChangeTagSheet visible={retagging} note={note} onClose={() => setRetagging(false)} />
    </>
  );
}

/**
 * Retagging, wherever it is reached from: this sheet's "Change tag" and the
 * detail screen's tag chip. One owner means the collision the unique
 * (title, tag) pair can raise is reported the same way from both.
 */
export function ChangeTagSheet({
  visible,
  note,
  onClose,
}: {
  visible: boolean;
  note: NoteWithBullets;
  onClose: () => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const updateNote = useUpdateNote();
  const tags = useNoteTags();
  const [draft, setDraft] = useState('');

  const submit = (value: string) => {
    const categoryTag = value.trim();
    if (!categoryTag) return;
    setDraft('');
    onClose();
    if (categoryTag.toLowerCase() === note.categoryTag.toLowerCase()) return;
    updateNote.mutate(
      { id: note.id, patch: { categoryTag } },
      {
        onSuccess: () => toast.show({ message: `Tagged ${categoryTag}`, tone: 'success' }),
        onError: (error) =>
          toast.show({
            // A (title, tag) pair is unique, so this is where "another note
            // already uses that title and tag" surfaces.
            message: errorMessage(error, 'I could not change that tag.'),
            tone: 'danger',
          }),
      },
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        style={[styles.backdrop, { backgroundColor: colors.overlay }]}
        onPress={onClose}
      />
      <View style={styles.wrap} pointerEvents="box-none">
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              padding: spacing.lg,
              paddingBottom: insets.bottom + spacing.lg,
              gap: spacing.md,
            },
          ]}
        >
          <Txt variant="heading">Change tag</Txt>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: spacing.xs }}
            style={{ flexGrow: 0 }}
          >
            {(tags.data ?? []).map((tag) => (
              <Chip
                key={tag.tag}
                label={tag.tag}
                color={colorForTag(tag.tag)}
                selected={tag.tag.toLowerCase() === note.categoryTag.toLowerCase()}
                onPress={() => submit(tag.tag)}
              />
            ))}
          </ScrollView>

          <Input
            label="Or a new tag"
            value={draft}
            onChangeText={setDraft}
            placeholder="hardware"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={(event) => submit(event.nativeEvent.text)}
          />

          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Button
              label="Save"
              variant="primary"
              disabled={!draft.trim()}
              onPress={() => submit(draft)}
            />
            <Button label="Cancel" variant="ghost" onPress={onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  wrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderWidth: StyleSheet.hairlineWidth },
});
