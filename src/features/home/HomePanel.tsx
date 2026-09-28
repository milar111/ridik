/**
 * The bottom of home: what you just said, or what you kept.
 *
 * One bounded, scrolling panel with two sides and a toggle between them —
 * **Said** is the conversation still inside the recall window, **Kept** is the
 * most recent notes. It is the shape the Stream ring's app uses, and the reason
 * to copy it is that a voice app has no menu: whatever is not on this screen is
 * behind a hamburger, and notes are the thing this app mostly produces.
 *
 * ## Which side opens, and why it is not simply remembered
 *
 * Said whenever there is a conversation, Kept otherwise. That reads as state
 * jumping under a thumb and is not, because of what sits *below* the panel:
 * `LastAction` is the receipt for the newest turn, it is outside this box, and
 * it is never hidden by either side. So the thing that must not be missed never
 * depends on which tab is showing, and the panel is free to open on whichever
 * side is actually useful — the conversation while one is happening, the notes
 * the rest of the time.
 *
 * A manual choice wins for as long as it can. It is dropped only when the side
 * the user picked has nothing in it, because a toggle that leaves you looking
 * at an empty box is worse than one that moved.
 *
 * ## The toggle only exists when it has two sides
 *
 * With notes and no conversation — most of the time — there is one pane and no
 * control above it. A segmented control with one reachable option is not a
 * choice, it is decoration on the screen with the least room for any.
 *
 * ## It paints its own ground, and it has to
 *
 * Everything on home sits on `HeatField`, an animated gradient, so the ground
 * under a word here is not a token — it is wherever the ember happens to be.
 * Measured on a device: the quiet line came out at **2.68:1** near the mic and
 * 3.50:1 two rows lower, the same colour failing by different amounts. No token
 * choice fixes a variable that is underneath. On `colors.surface` the same line
 * measures **7.18:1**.
 *
 * The ground goes on a wrapper `View`, never on the `ScrollView` itself: a
 * `ScrollView` does not clip to its own `borderRadius` on iOS, so the panel
 * drew correctly while its rows scrolled straight out past the top of it onto
 * the ember, at exactly the contrast this exists to avoid. Android clips to its
 * background anyway, which is why that was a defect on one platform and
 * invisible on the other.
 *
 * And the height is bounded rather than grown. Home's layout is fixed on
 * purpose — the microphone sits in the same place every time the app opens and
 * nothing may push it out from under a thumb — so this scrolls inside itself
 * and the stage above it gives up a fixed amount.
 */
import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { useVoiceStore } from '@/features/voice/store';
import { useTheme } from '@/ui/ThemeProvider';
import { Segmented } from '@/ui/components';
import { KeptNotes, useKeptNotes } from './KeptNotes';
import { RecentTurns, useRecentTurns } from './RecentTurns';

/** Tall enough for two turns, short enough to leave the mic where it was. */
export const HOME_PANEL_MAX_HEIGHT = 148;

/**
 * The toggle's row, reserved whether or not there is a toggle in it.
 *
 * `Segmented` is a `caption` (18pt line) plus 6pt of segment padding either
 * side, 2pt of its own, and a hairline border: 35. Measured on a device rather
 * than trusted — with the row *not* reserved, the mic's centre sat at y=1198
 * with the toggle and y=1256 without it, a 19pt drift. The stage is `flex: 1`
 * and centres the mic, so anything that appears down here takes half its height
 * off the top of the microphone.
 *
 * That is the one thing home is built around: "the mic sits in the same place
 * every time the app opens, and nothing above or below it can push it out from
 * under your thumb." The toggle comes and goes on a *ten-minute* boundary,
 * which is exactly the kind of movement nobody would connect to anything they
 * did. Reserving the row costs an invisible 35pt gap over a gradient.
 */
const TOGGLE_ROW = 35;

type Side = 'said' | 'kept';

const LABELS: { value: Side; label: string }[] = [
  { value: 'said', label: 'Said' },
  { value: 'kept', label: 'Kept' },
];

export function HomePanel() {
  const { colors, spacing, radius } = useTheme();
  const scroller = useRef<ScrollView>(null);
  const status = useVoiceStore((s) => s.status);
  const [chosen, setChosen] = useState<Side | null>(null);

  const lines = useRecentTurns();
  const notes = useKeptNotes();

  const hasSaid = lines.length > 0;
  const hasKept = notes.length > 0;

  // A manual pick wins until the side it picked empties out; otherwise the
  // conversation leads whenever there is one.
  const wanted: Side = chosen ?? (hasSaid ? 'said' : 'kept');
  const side: Side = wanted === 'said' && !hasSaid ? 'kept' : wanted === 'kept' && !hasKept ? 'said' : wanted;

  /*
   * Keep the newest turn in view as the conversation grows past the box.
   *
   * The two sides read in opposite directions, which is the whole reason the
   * `key` below exists. Said is oldest-first and ends at the live receipt, so
   * it belongs scrolled to the bottom; Kept is newest-first and belongs at the
   * top. They share one `ScrollView`, so switching sides used to carry the
   * offset across — tapping Kept landed you mid-list with the newest note's
   * title clipped off the top, which reads as a broken list rather than a
   * scrolled one. Found on a device; a remount is the cheapest correct fix and
   * costs four rows.
   */
  useEffect(() => {
    if (side === 'said' && hasSaid) scroller.current?.scrollToEnd({ animated: true });
  }, [side, hasSaid, lines.length]);

  // The empty case is a fresh install, and a box with nothing in it is the
  // defect `Card` returns null for.
  if (!hasSaid && !hasKept) return null;

  return (
    <View style={{ gap: spacing.xs }}>
      <View style={{ height: TOGGLE_ROW }}>
        {hasSaid && hasKept ? (
          <Segmented value={side} onChange={setChosen} options={LABELS} />
        ) : null}
      </View>

      <View
        style={{
          maxHeight: HOME_PANEL_MAX_HEIGHT,
          backgroundColor: colors.surface,
          borderRadius: radius.lg,
          overflow: 'hidden',
        }}
      >
        <ScrollView
          key={side}
          testID={side === 'said' ? 'recent-turns' : 'kept-notes'}
          ref={scroller}
          /* The padding is on the content rather than the box: a `ScrollView`'s
             own vertical padding scrolls away with the content under it, so the
             first row would sit flush against the top edge the moment anything
             moved. */
          contentContainerStyle={{ gap: spacing.sm, padding: spacing.md }}
          showsVerticalScrollIndicator={false}
          /* While the recogniser is running, the caption under the mic is the
             live transcript and is the thing to be reading. A second scrolling
             region competing for a screen reader's attention mid-utterance is
             the "one voice per event" rule broken by a component that is not
             even reporting the event. */
          accessibilityElementsHidden={status === 'listening'}
          importantForAccessibility={status === 'listening' ? 'no-hide-descendants' : 'auto'}
        >
          {side === 'said' ? <RecentTurns lines={lines} /> : <KeptNotes notes={notes} />}
        </ScrollView>
      </View>
    </View>
  );
}
