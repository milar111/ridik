/**
 * What you kept — the other half of the home panel, and the reason notes
 * stopped being two taps away.
 *
 * Notes lived behind the menu, which is right for a screen you go to and wrong
 * for the thing this app mostly produces. Almost every utterance that is not a
 * command now lands here (see RULE 18 in `src/llm/prompt.ts`), so "where did
 * that go?" was being answered by a hamburger, a sheet and a list — three moves
 * to read a sentence you spoke forty seconds ago.
 *
 * ## It is a reading surface, not a directory
 *
 * Title and the first line of the note, which is the pair that identifies it —
 * a generated title like "Daily Log, Sep 11" says nothing on its own and the
 * sentence under it says everything. Deliberately *not* the full note:
 * `app/notes.tsx` shows those complete (see `./preview`), and this is the
 * shortlist that gets you there. Each row opens its own note; the last row
 * opens the screen.
 *
 * ## What it costs, and the rule it bends
 *
 * Home is documented as a microphone with everything else behind the menu, and
 * anything permanent down here is furniture — that is the argument that removed
 * a list of example sentences from this exact slot. This is the owner's call
 * taken with that known: notes are the app's own output, and a note you cannot
 * find is one that may as well not have been written.
 *
 * Two things keep it honest. It draws **nothing at all** on an install with no
 * notes, so a first run is still a microphone and nothing else. And the panel
 * it shares gives the conversation priority the moment there is one — see
 * `HomePanel` — so speaking never has to argue with a list for the screen.
 */
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useNotes } from '@/hooks';
import type { NoteWithBullets } from '@/repositories/notes';
import { useTheme } from '@/ui/ThemeProvider';
import { Txt } from '@/ui/components/Text';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';

/**
 * How many are worth putting on home.
 *
 * Six is about two panel-heights of scrolling — enough that the note you are
 * looking for is usually already there, short enough that this stays a
 * shortlist. Everything else is one tap further on, and the row that says so is
 * the last one.
 */
export const KEPT_NOTES = 6;

export function useKeptNotes(): NoteWithBullets[] {
  const { data } = useNotes({ limit: KEPT_NOTES });
  return data ?? [];
}

export function KeptNotes({ notes }: { notes: readonly NoteWithBullets[] }) {
  const router = useRouter();
  const { colors, spacing } = useTheme();

  return (
    <>
      {notes.map((note) => (
        <KeptNote key={note.id} note={note} onPress={() => router.push(`/note/${note.id}`)} />
      ))}

      {/* The way out of a shortlist. Without it this is a list that silently
          stops, and the only clue that there are more notes is that the ones
          you remember are missing. */}
      <AnimatedPressable
        testID="kept-notes-all"
        accessibilityRole="button"
        accessibilityLabel="All notes"
        accessibilityHint="Opens the notes screen"
        onPress={() => router.push('/notes')}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingTop: 2 }}
      >
        <Txt variant="micro" tone="accent" weight="600">
          All notes
        </Txt>
        <Ionicons name="chevron-forward" size={11} color={colors.accent} />
      </AnimatedPressable>
      <View style={{ height: spacing.xs }} />
    </>
  );
}

function KeptNote({ note, onPress }: { note: NoteWithBullets; onPress: () => void }) {
  const { colors, spacing } = useTheme();
  const press = usePressScale({ scale: 0.99 });

  // The first line, whatever kind it is. A note with no bullets says so rather
  // than drawing a title over a gap — the same rule `Card` enforces one level
  // up, applied to a row.
  const first = note.bullets[0]?.content.trim();

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={first ? `${note.titleSummary}. ${first}` : note.titleSummary}
      accessibilityHint="Opens this note"
      onPress={onPress}
      {...press.handlers}
      style={[
        {
          borderLeftWidth: 2,
          borderLeftColor: colors.border,
          paddingLeft: spacing.sm,
          gap: 2,
        },
        press.style,
      ]}
    >
      <Txt variant="caption" weight="600" numberOfLines={1}>
        {note.titleSummary}
      </Txt>
      <Txt variant="micro" tone="tertiary" numberOfLines={1}>
        {first ?? 'Empty'}
      </Txt>
    </AnimatedPressable>
  );
}
