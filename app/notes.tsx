import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { countLabel } from '@/core/format';
import {
  ChecklistSection,
  ErrorRow,
  NewListDialog,
  NoteActionsSheet,
  NoteRow,
  SkeletonRows,
  TagStrip,
  errorMessage,
  useDebounced,
} from '@/features/notes';
import { useChecklistNames, useNoteSearch, useNoteTags, useNotes } from '@/hooks';
import type { NoteWithBullets } from '@/repositories/notes';
import {
  Button,
  Divider,
  EmptyState,
  Input,
  MIC_CLEARANCE,
  Screen,
  Segmented,
  Spinner,
  Txt,
} from '@/ui/components';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useStaggeredEntry } from '@/ui/motionHooks';
import { useTheme } from '@/ui/ThemeProvider';

type Pane = 'notes' | 'lists';

/**
 * The staggered arrival, made safe for a `FlatList`.
 *
 * A mapped list mounts every row once and is done. A `FlatList` mounts a cell
 * the moment it scrolls into the window, so the same `entering` prop stops
 * being an arrival and becomes an entrance *on scroll* — the row you dragged
 * into view fades in under your thumb, and does it again every time you come
 * back to it. That is the one thing a list animation must not do.
 *
 * The guard is the gesture itself, not a timer: once the list has been dragged,
 * nothing in it is arriving any more, it is being uncovered. A ref rather than
 * state on purpose — flipping it must not re-render the list mid-scroll, and it
 * is read at cell-render time, which is exactly when the answer is needed.
 *
 * Spread `handlers` onto the list; hand `entering(index)` to the row.
 */
function useMountWave() {
  const arrive = useStaggeredEntry({ from: 'below' });
  const scrolled = useRef(false);
  const settle = useCallback(() => {
    scrolled.current = true;
  }, []);

  const entering = useCallback(
    (index: number) => (scrolled.current ? undefined : arrive(index)),
    [arrive],
  );

  const handlers = useMemo(
    () => ({ onScrollBeginDrag: settle, onMomentumScrollBegin: settle }),
    [settle],
  );

  return { entering, handlers };
}

/**
 * Two capture surfaces that the brief keeps strictly apart, behind one control.
 * Notes are things you keep and re-read; lists are things you tick off and
 * throw away. Mixing them in one feed loses both.
 *
 * `?pane=lists&list=Shopping` is the only address a checklist has: it is what a
 * voice result deep-links to, so the pane has to be part of the URL.
 */
export default function NotesScreen() {
  const { spacing } = useTheme();
  const { pane: wanted, list } = useLocalSearchParams<{ pane?: string; list?: string }>();
  const [pane, setPane] = useState<Pane>(wanted === 'lists' || list ? 'lists' : 'notes');

  // A result is usually tapped while this tab is already open on Notes, so the
  // URL has to be able to move the pane and not merely choose it on mount.
  // Pressing the segmented control changes neither dep, so the user's own
  // choice is never overridden afterwards.
  useEffect(() => {
    if (wanted === 'lists' || list) setPane('lists');
  }, [wanted, list]);

  return (
    <Screen back title="Notes" scroll={false} contentStyle={{ flex: 1, gap: spacing.sm }}>
      <Segmented
        value={pane}
        onChange={setPane}
        options={[
          { value: 'notes', label: 'Notes' },
          { value: 'lists', label: 'Lists' },
        ]}
      />
      <ErrorBoundary label={pane === 'notes' ? 'notes list' : 'checklists'}>
        {pane === 'notes' ? <NotesPane /> : <ListsPane focus={list} />}
      </ErrorBoundary>
    </Screen>
  );
}

/* ------------------------------------------------------------------ notes -- */

function NotesPane() {
  const router = useRouter();
  const { colors, spacing } = useTheme();

  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<NoteWithBullets | null>(null);
  const wave = useMountWave();

  const term = useDebounced(query, 200).trim();
  const searching = term.length > 0;

  const tags = useNoteTags();
  const browse = useNotes(tag ? { tag } : {});
  const hits = useNoteSearch(term, { enabled: searching });

  /**
   * Both orderings come straight from the repository — pinned-then-recent when
   * browsing, relevance-with-pin-as-tiebreak when searching — so the screen does
   * not re-sort. Hoisting a barely-matching pinned note above the one the user
   * is actually looking for is exactly the bug the repository avoids.
   */
  const notes = useMemo<NoteWithBullets[]>(() => {
    if (!searching) return browse.data ?? [];
    const found = (hits.data ?? []).map((hit) => hit.note);
    // `searchNotes` takes no tag, so the strip filters the hits it returns.
    return tag ? found.filter((n) => n.categoryTag.toLowerCase() === tag.toLowerCase()) : found;
  }, [searching, browse.data, hits.data, tag]);

  const active = searching ? hits : browse;
  const cold = active.isPending && notes.length === 0;
  const total = (tags.data ?? []).reduce((sum, entry) => sum + entry.count, 0);

  return (
    <View style={{ flex: 1, gap: spacing.sm }}>
      <Input
        value={query}
        onChangeText={setQuery}
        placeholder="Search your notes…"
        accessibilityLabel="Search notes"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
      />

      <TagStrip tags={tags.data ?? []} selected={tag} onSelect={setTag} total={total} />

      {active.error ? (
        <ErrorRow
          message={errorMessage(active.error, 'I could not read your notes.')}
          onRetry={() => void active.refetch()}
        />
      ) : null}

      {cold ? (
        <SkeletonRows count={6} height={62} />
      ) : (
        <FlatList
          data={notes}
          keyExtractor={(note) => note.id}
          {...wave.handlers}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          ItemSeparatorComponent={Divider}
          contentContainerStyle={{ paddingBottom: MIC_CLEARANCE }}
          ListEmptyComponent={
            <NotesEmpty searching={searching} term={term} tag={tag} onClearTag={() => setTag(null)} />
          }
          ListFooterComponent={
            // A refetch over rows that are already on screen must not replace
            // them; the spinner is the only thing that moves.
            active.isFetching && !cold ? (
              <View style={{ paddingVertical: spacing.md }}>
                <Spinner color={colors.textTertiary} accessibilityLabel="Looking for more notes" />
              </View>
            ) : null
          }
          renderItem={({ item, index }) => (
            // Searching swaps the whole data set for another one, which
            // remounts every cell — so a search you have not scrolled yet
            // arrives as a wave, which is the honest reading: these are new
            // rows, not the old ones re-ordered.
            <Animated.View entering={wave.entering(index)}>
              <NoteRow
                note={item}
                onPress={() => router.push(`/note/${item.id}`)}
                onLongPress={() => setMenuFor(item)}
              />
            </Animated.View>
          )}
        />
      )}

      <NoteActionsSheet
        note={menuFor}
        visible={menuFor !== null}
        onClose={() => setMenuFor(null)}
      />
    </View>
  );
}

function NotesEmpty({
  searching,
  term,
  tag,
  onClearTag,
}: {
  searching: boolean;
  term: string;
  tag: string | null;
  onClearTag: () => void;
}) {
  if (searching) {
    return (
      <EmptyState
        icon="search-outline"
        title={`Nothing matches “${term}”`}
        hint="Notes are found by their words, never by their date. Try a word that is actually in the note."
      />
    );
  }
  if (tag) {
    return (
      <View>
        <EmptyState
          icon="pricetag-outline"
          title={`Nothing tagged ${tag}`}
          hint={`Try: “note under ${tag}: first thing, second thing”`}
        />
        <View style={{ alignItems: 'center' }}>
          <Button label="Show all notes" size="sm" variant="ghost" onPress={onClearTag} />
        </View>
      </View>
    );
  }
  return (
    <EmptyState
      icon="document-text-outline"
      title="No notes yet"
      hint="Try: “note under hardware — M3 screws, 20mm standoffs, order Thursday”"
    />
  );
}

/* ------------------------------------------------------------------ lists -- */

function ListsPane({ focus }: { focus?: string }) {
  const { spacing } = useTheme();
  const names = useChecklistNames();
  const wave = useMountWave();

  const [creating, setCreating] = useState(false);
  // `null` means "untouched", so the first list can start open without that
  // choice sticking after the user has collapsed it.
  const [opened, setOpened] = useState<Set<string> | null>(null);
  const lists = names.data ?? [];
  const fallback = useMemo(
    () => new Set(lists[0] ? [lists[0].name] : []),
    [lists],
  );
  const expanded = opened ?? fallback;

  // A link carries the list in whatever words produced it; the sections are
  // keyed on the stored name.
  const target = useMemo(() => {
    const wanted = focus?.trim().toLowerCase();
    if (!wanted) return undefined;
    return lists.find((entry) => entry.name.toLowerCase() === wanted)?.name;
  }, [focus, lists]);

  useEffect(() => {
    if (target) setOpened(new Set([target]));
  }, [target]);

  const toggle = (name: string) =>
    setOpened(() => {
      const next = new Set(expanded);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  if (names.isPending) return <SkeletonRows count={5} height={40} />;

  if (names.error) {
    return (
      <ErrorRow
        message={errorMessage(names.error, 'I could not read your lists.')}
        onRetry={() => void names.refetch()}
      />
    );
  }

  const stillOpen = lists.reduce((sum, entry) => sum + entry.open, 0);

  return (
    <>
      <FlatList
        data={lists}
        keyExtractor={(list) => list.name}
        {...wave.handlers}
        keyboardShouldPersistTaps="handled"
        ItemSeparatorComponent={Divider}
        contentContainerStyle={{ paddingBottom: MIC_CLEARANCE }}
        ListHeaderComponent={
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.sm,
              paddingBottom: spacing.xs,
            }}
          >
            {lists.length > 0 ? (
              <Txt variant="caption" tone="tertiary" style={{ flex: 1 }}>
                {countLabel(lists.length, 'list')} · {stillOpen} still open
              </Txt>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            <Button
              label="New list"
              icon="add"
              size="sm"
              variant="ghost"
              onPress={() => setCreating(true)}
            />
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            icon="list-outline"
            title="No lists yet"
            hint="Try: “add M3 screws to my hardware list”"
          />
        }
        renderItem={({ item, index }) => (
          // The section's own rows carry a second, inner stagger when it is
          // expanded. They do not collide: this one runs on the screen opening,
          // that one on the disclosure.
          <Animated.View entering={wave.entering(index)}>
            <ChecklistSection
              summary={item}
              expanded={expanded.has(item.name)}
              onToggleExpanded={() => toggle(item.name)}
            />
          </Animated.View>
        )}
      />

      <NewListDialog
        visible={creating}
        onClose={() => setCreating(false)}
        // A list you have just started is the one you are about to fill.
        onCreated={(name) => setOpened(new Set([name]))}
      />
    </>
  );
}
