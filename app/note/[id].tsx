import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { countLabel } from '@/core/format';
import { copyToClipboard, shareAsFile } from '@/features/export';
import {
  BulletList,
  ChangeTagSheet,
  ErrorRow,
  NoteActionsSheet,
  SkeletonRows,
  errorMessage,
  type SheetAction,
} from '@/features/notes';
import { noteFilename, noteMarkdown } from '@/features/notes/markdown';
import { useAppendNoteBullets, useNote, useUpdateNote } from '@/hooks';
import type { BulletKind, NoteWithBullets } from '@/repositories/notes';
import { Button, Chip, Divider, EmptyState, Input, Screen, Txt, useToast } from '@/ui/components';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import { colorForTag } from '@/ui/theme';

export default function NoteDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors, spacing } = useTheme();
  const note = useNote(id);
  const [menuOpen, setMenuOpen] = useState(false);

  const data = note.data ?? null;
  const extras = useNoteMenuExtras(data);

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

        <View style={{ flex: 1 }} />

        {data?.isPinned ? <Ionicons name="pin" size={16} color={colors.accent} /> : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Note actions"
          hitSlop={12}
          disabled={!data}
          onPress={() => setMenuOpen(true)}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : data ? 1 : 0.3 })}
        >
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.text} />
        </Pressable>
      </View>

      {note.isPending ? <SkeletonRows count={7} height={38} /> : null}

      {note.error ? (
        <ErrorRow
          message={errorMessage(note.error, 'I could not open that note.')}
          onRetry={() => void note.refetch()}
        />
      ) : null}

      {!note.isPending && !note.error && !data ? (
        <View>
          <EmptyState
            icon="help-circle-outline"
            title="That note is gone"
            hint="It was deleted, or the link is stale."
          />
          <View style={{ alignItems: 'center' }}>
            <Button label="Back to notes" variant="ghost" onPress={() => router.back()} />
          </View>
        </View>
      ) : null}

      {data ? (
        <ErrorBoundary label="note">
          <NoteBody note={data} />
        </ErrorBoundary>
      ) : null}

      <NoteActionsSheet
        note={data}
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        onDeleted={() => router.back()}
        extraActions={extras}
      />
    </Screen>
  );
}

/**
 * The one menu entry that only makes sense with the note open. Kept as a hook
 * so the sheet itself stays the single owner of pin/tag/archive/delete.
 */
function useNoteMenuExtras(note: NoteWithBullets | null): SheetAction[] {
  const toast = useToast();
  if (!note) return [];

  const share = async () => {
    const markdown = noteMarkdown(note);
    const shared = await shareAsFile(markdown, noteFilename(note), {
      dialogTitle: note.titleSummary,
    });
    if (shared.ok) return;
    // A locked-down device has no share sheet; the clipboard almost always
    // still works, and a note the user cannot get out of the app is a trap.
    const copied = await copyToClipboard(markdown);
    toast.show(
      copied.ok
        ? { message: 'Copied to clipboard', detail: note.titleSummary, tone: 'success' }
        : { message: errorMessage(shared.error, 'I could not share that note.'), tone: 'danger' },
    );
  };

  return [{ label: 'Share', icon: 'share-outline', onPress: () => void share() }];
}

function NoteBody({ note }: { note: NoteWithBullets }) {
  const { colors, spacing, typography } = useTheme();
  const toast = useToast();
  const updateNote = useUpdateNote();
  const appendBullets = useAppendNoteBullets();

  const [title, setTitle] = useState(note.titleSummary);
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<BulletKind>('text');
  const [retagging, setRetagging] = useState(false);

  /**
   * Re-seeds the field from the row, which is also the rollback: a rename the
   * repository refuses (the title+tag pair is unique) invalidates and refetches,
   * and the field snaps back to what is actually stored.
   */
  useEffect(() => setTitle(note.titleSummary), [note.titleSummary]);

  const rename = (next: string) => {
    const value = next.trim();
    if (!value || value === note.titleSummary) {
      setTitle(note.titleSummary);
      return;
    }
    updateNote.mutate(
      { id: note.id, patch: { titleSummary: value } },
      {
        onError: (error) =>
          toast.show({
            message: errorMessage(error, 'I could not rename that note.'),
            tone: 'danger',
          }),
      },
    );
  };

  const add = (value: string) => {
    const content = value.trim();
    if (!content) return;
    setDraft('');
    appendBullets.mutate(
      { noteId: note.id, contents: [content], kind },
      {
        onError: (error) =>
          toast.show({
            message: errorMessage(error, 'I could not add that bullet.'),
            tone: 'danger',
          }),
      },
    );
  };

  const done = note.bullets.filter((bullet) => bullet.isCompleted).length;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1 }}
    >
      <ScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: spacing.md, gap: spacing.sm }}
        showsVerticalScrollIndicator={false}
      >
        <Input
          value={title}
          onChangeText={setTitle}
          accessibilityLabel="Note title"
          placeholder="Untitled"
          returnKeyType="done"
          onSubmitEditing={(event) => rename(event.nativeEvent.text)}
          onBlur={() => rename(title)}
          style={typography.title}
        />

        {/* The tag is the note's grouping key and half of the unique
            (title, tag) pair, so it is chosen from what exists rather than
            typed over: the picker is the only way to change it. */}
        <View style={styles.tagRow}>
          <Chip
            label={note.categoryTag}
            icon="pricetag-outline"
            color={colorForTag(note.categoryTag)}
            // The bare tag was a labelled field before; on its own it does not
            // say it is the tag, or that tapping it changes one.
            accessibilityHint="Changes the tag on this note"
            onPress={() => setRetagging(true)}
          />
        </View>

        <View style={styles.counts}>
          <Txt variant="micro" tone="tertiary">
            {countLabel(note.bullets.length, 'bullet')}
            {done > 0 ? ` · ${done} done` : ''}
          </Txt>
        </View>

        <Divider />

        {note.bullets.length === 0 ? (
          <EmptyState
            icon="add-circle-outline"
            title="Nothing in here yet"
            hint={`Try: “add two more points to ${note.titleSummary}”`}
          />
        ) : (
          <BulletList note={note} />
        )}
      </ScrollView>

      <View
        style={[
          styles.composer,
          { borderTopColor: colors.border, paddingTop: spacing.sm, gap: spacing.sm },
        ]}
      >
        <Button
          icon={kind === 'todo' ? 'checkbox-outline' : 'ellipse-outline'}
          size="sm"
          style={{ minWidth: 44, minHeight: 42 }}
          accessibilityLabel={kind === 'todo' ? 'Adding as a todo' : 'Adding as a plain bullet'}
          onPress={() => setKind(kind === 'todo' ? 'text' : 'todo')}
        />
        <Input
          containerStyle={{ flex: 1 }}
          value={draft}
          onChangeText={setDraft}
          placeholder={kind === 'todo' ? 'Add a todo…' : 'Add a bullet…'}
          accessibilityLabel="Add a bullet"
          returnKeyType="done"
          // Keeps the keyboard up: bullets arrive in runs, not one at a time.
          submitBehavior="submit"
          onSubmitEditing={(event) => add(event.nativeEvent.text)}
        />
        <Button
          icon="arrow-up"
          variant="primary"
          size="sm"
          style={{ minWidth: 44, minHeight: 42 }}
          accessibilityLabel="Add bullet"
          disabled={!draft.trim()}
          onPress={() => add(draft)}
        />
      </View>

      <ChangeTagSheet visible={retagging} note={note} onClose={() => setRetagging(false)} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  tagRow: { flexDirection: 'row', alignItems: 'center' },
  counts: { flexDirection: 'row', justifyContent: 'flex-end' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
