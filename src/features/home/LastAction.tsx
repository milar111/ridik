/**
 * What Ridik just did, on the screen you were already looking at.
 *
 * This is what makes a voice-only home honest. Speaking is fast because you do
 * not have to look — which is exactly why a mis-heard word would otherwise land
 * silently and stay wrong. The receipt is the smallest thing that closes that
 * loop: it names what happened, opens it if you want to check, and takes it
 * back when taking it back is safe.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, {
  FadeOut,
  useReducedMotion,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/ThemeProvider';
import { useAnnounceOnIOS } from '@/ui/a11y';
import { Txt } from '@/ui/components/Text';
import { useToast } from '@/ui/components';
import { useVoiceStore } from '@/features/voice/store';
import { useVoiceUndo } from '@/hooks/useVoiceUndo';
import { SPRING_ENTER } from '@/ui/motion';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import { elevate } from '@/ui/shadow';
import { HomeExamples } from './HomeExamples';
import { lastUndoable } from './undo';

/**
 * A spring rather than a fade, and from below rather than in place: the card is
 * reporting that something just happened, and only movement says "just".
 */
const SlideInFromBelow = () => {
  'worklet';
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 18 }, { scale: 0.97 }] },
    animations: {
      opacity: withTiming(1, { duration: 200 }),
      transform: [{ translateY: withSpring(0, SPRING_ENTER) }, { scale: withSpring(1, SPRING_ENTER) }],
    },
  };
};

export function LastAction() {
  const { colors, radius, spacing } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const undo = useVoiceUndo();
  const reduced = useReducedMotion();
  const [undone, setUndone] = useState<string | null>(null);
  // Above the "nothing applied" return, or the hook order changes the moment
  // the receipt has nothing to show.
  const openPress = usePressScale({ scale: 0.98 });
  const undoPress = usePressScale();

  const outcome = useVoiceStore((s) => s.outcome);
  const open = useVoiceStore((s) => s.open);
  // Not for drawing — for knowing whether this screen is actually empty. See
  // the gate below.
  const error = useVoiceStore((s) => s.error);
  const recovered = useVoiceStore((s) => s.recovered);

  const items = outcome?.items ?? [];
  const applied = items.filter((item) => item.ok);
  const headline = applied.length > 0 ? applied[applied.length - 1]! : null;
  const undoable = lastUndoable(items);
  // Keyed by id: speaking again replaces the outcome, so a stale "Undone" can
  // never sit under a newer action.
  const isUndone = undoable !== null && undone === undoable.id;

  /**
   * The receipt as one sentence, because a card that springs up says nothing.
   *
   * Speaking is fast because you do not have to look — and a screen reader does
   * not look either. Without this the person least able to catch a mis-heard
   * word is the only one who is never told what landed, which is the safety
   * model missing rather than degraded.
   *
   * Whether it was undone leads, and it is a word rather than the greyed
   * arrow-undo glyph the sighted card uses: state that only exists as a colour
   * and an icon does not exist at all here.
   *
   * Computed above the `return null`, with the press hooks, or the hook order
   * changes the moment the receipt has nothing to show.
   */
  const receipt = headline
    ? `${isUndone ? 'Undone' : 'Done'}. ${headline.summary}` +
      (applied.length > 1 ? `, and ${applied.length - 1} more` : '')
    : null;
  // Android hears the card itself: it is an `accessibilityLiveRegion` below.
  useAnnounceOnIOS(receipt);

  // Nothing applied is several situations and only one of them is empty.
  //
  // Before anything has been said at all — every cold start — this space is the
  // only room the app has to say what it is for, so it gets examples. After a
  // turn that went wrong it stays blank: the failure is already on screen with
  // its reason, and a list of other things to try underneath it reads as the
  // app changing the subject.
  //
  // A failure is three different states rather than one, which is why the test
  // is not simply `outcome`. A turn that ran and wrote nothing has an outcome;
  // a turn that threw has none but has kept its transcript, and `UnsentTranscript`
  // is drawn directly above this on home; a session that heard nothing at all
  // has neither, only the error. Examples belong under none of them.
  //
  // Below the announcement above, not above it: this return is conditional and
  // `useAnnounceOnIOS` is a hook, so moving it up would change the hook order
  // the moment the receipt had nothing to show.
  if (!headline || !receipt) {
    return outcome || recovered || error ? null : <HomeExamples />;
  }

  const runUndo = () => {
    if (!undoable) return;
    void undo
      .run(undoable)
      .then(() => {
        setUndone(undoable.id);
        toast.show({ message: 'Undone', tone: 'success' });
      })
      .catch((error: unknown) =>
        toast.show({
          message: error instanceof Error ? error.message : 'That could not be undone.',
          tone: 'danger',
        }),
      );
  };

  return (
    <Animated.View
      testID="last-action"
      // Springs up from below rather than fading in: something arrived, and a
      // fade would read as it having been there all along.
      entering={reduced ? undefined : SlideInFromBelow}
      exiting={reduced ? undefined : FadeOut.duration(160)}
      // The spring is the sighted half of "this just happened"; this is the
      // other half. Polite rather than assertive: the receipt is news, not an
      // emergency, and a turn that ends in a question has already interrupted.
      accessibilityLiveRegion="polite"
      style={{
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        padding: spacing.md,
        gap: 6,
        ...elevate('card'),
      }}
    >
      <AnimatedPressable
        testID="last-action-open"
        accessibilityRole="button"
        // The same sentence that was announced, so what was heard once can be
        // found again by touch. The tick and the "and 2 more" underneath it are
        // both in it: neither survives as a colour or a second line.
        accessibilityLabel={receipt}
        accessibilityHint="Opens what Ridik just did"
        // No href is not a dead tap: the sheet still holds the full result, and
        // the rest of what a multi-part sentence did lives there too.
        onPress={() => (headline.href ? router.push(headline.href as never) : open())}
        {...openPress.handlers}
        style={[
          { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
          openPress.style,
        ]}
      >
        <Ionicons
          name={isUndone ? 'arrow-undo' : 'checkmark-circle'}
          size={17}
          color={isUndone ? colors.textTertiary : colors.success}
        />
        <View style={{ flex: 1, gap: 1 }}>
          <Txt variant="caption" weight="600" numberOfLines={2} tone={isUndone ? 'tertiary' : undefined}>
            {headline.summary}
          </Txt>
          {applied.length > 1 ? (
            <Txt variant="micro" tone="tertiary">
              and {applied.length - 1} more
            </Txt>
          ) : null}
        </View>
        <Ionicons name="chevron-forward" size={14} color={colors.textTertiary} />
      </AnimatedPressable>

      {undoable && !isUndone ? (
        <AnimatedPressable
          testID="last-action-undo"
          accessibilityRole="button"
          accessibilityLabel={
            undo.isPending ? `Undoing ${undoable.summary}` : `Undo ${undoable.summary}`
          }
          accessibilityHint="Takes back what Ridik just did"
          // The in-flight dim below is state, and a dim is invisible to a
          // screen reader. `busy` is how the same fact is said out loud.
          accessibilityState={{ disabled: undo.isPending, busy: undo.isPending }}
          disabled={undo.isPending}
          onPress={runUndo}
          {...undoPress.handlers}
          // The in-flight dim stays: it is state, not press feedback, and it is
          // the only thing saying the undo has been asked for and not answered.
          style={[{ alignSelf: 'flex-start', opacity: undo.isPending ? 0.5 : 1 }, undoPress.style]}
        >
          <Txt variant="caption" tone="accent" weight="600">
            {undo.isPending ? 'Undoing…' : 'Undo'}
          </Txt>
        </AnimatedPressable>
      ) : null}
    </Animated.View>
  );
}
