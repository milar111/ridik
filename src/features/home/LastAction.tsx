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
import { isWrite } from '@/llm/confirm';
import { useVoiceStore } from '@/features/voice/store';
import { useVoiceUndo } from '@/hooks/useVoiceUndo';
import { SPRING_ENTER } from '@/ui/motion';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import { elevate } from '@/ui/shadow';
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
  const items = outcome?.items ?? [];
  const applied = items.filter((item) => item.ok);
  // The newest *change* leads when there is one. A sentence that files
  // something and asks something can come back with a read (a search, a
  // lookup) as its last item, and leading with that hid the receipt behind a
  // match count — the answer itself is `reply`, drawn underneath.
  const writes = applied.filter((item) => isWrite(item.toolName));
  const headline =
    writes.length > 0 ? writes[writes.length - 1]! : applied.length > 0 ? applied[applied.length - 1]! : null;
  const undoable = lastUndoable(items);
  /*
   * The model's own sentence, and the only place an answer lives when nothing
   * was written ("when is Ivo's birthday?") or when the same sentence also
   * changed something. A pure answer used to reach the sheet and the speaker
   * only, so on home — where the sheet stays shut — it reached nobody.
   */
  const reply = outcome?.reply?.trim() || null;
  const answerOnly = headline === null && reply !== null && !outcome?.clarification;
  /*
   * Whether the undo button takes back the thing the card is describing.
   *
   * `headline` is the last *applied* item; `undoable` is the last item on the
   * allow-list. In a mixed batch those are different rows and nothing tied them
   * together — "remind me to call Dad and start a 25 minute timer" drew
   * `Started "Focus" — 25m in 1 block.` above a bare **Undo** that deleted the
   * task, left the timer running, and then greyed the *timer* line. The name of
   * what was about to be deleted existed only in the accessibility label, so a
   * sighted user was never shown it and afterwards was told the wrong thing had
   * been undone.
   */
  const undoesHeadline = undoable !== null && headline !== null && undoable.id === headline.entityId;
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
  /*
   * An answer is not a receipt, and drawing it as one is why "what does my day
   * look like" arrived in a small box at the foot of the screen with the word
   * **Done.** in front of it.
   *
   * A receipt reports a *change*: it is short by construction ("Added “Dentist”
   * — Tue 15:00"), it wants a tick, and it wants an Undo. An answer is the
   * thing that was asked for. It has no tick to earn, nothing to take back, and
   * it is as long as the day is — a briefing is three or four lines and the two
   * of them were sharing one two-line clamp.
   *
   * `isWrite` already draws this line for the confirmation gate, so it is the
   * same list rather than a second one that can drift from it.
   */
  const isAnswer = answerOnly || (headline !== null && !isWrite(headline.toolName));
  // A write that came with a question: the receipt draws the change, the
  // model's sentence carries the answer underneath it.
  const alsoAnswered =
    headline !== null && !isAnswer && reply !== null && asksSomething(outcome?.transcript ?? '');

  const receipt = answerOnly
    ? reply
    : headline
    ? isAnswer
      ? headline.summary
      : isUndone
      ? // What was actually taken back, which is not always the headline. The
        // sentence used to read "Undone. Started \"Focus\" — 25m in 1 block."
        // after undoing a *task* in the same batch, leaving the timer running
        // and telling the one person who cannot see the card that the wrong
        // thing had been reversed.
        `Undone. ${undoable.summary}`
        : `Done. ${headline.summary}` +
          (applied.length > 1 ? `, and ${applied.length - 1} more` : '') +
          (alsoAnswered ? ` ${reply}` : '')
    : null;
  // Android hears the card itself: it is an `accessibilityLiveRegion` below.
  useAnnounceOnIOS(receipt);

  // Nothing applied is several situations and only one of them is empty.
  //
  // Before anything has been said at all — every cold start — this space is the
  // Nothing at all when there is no receipt.
  //
  // There used to be a list of example sentences here. It was the only room
  // the app had to say what it was for, and it was removed deliberately: the
  // examples were permanent furniture on the resting screen, so the state a
  // user sees most of the time was a page of suggestions rather than an
  // instrument at rest. The mic and its caption already say what to do.
  if ((!headline && !answerOnly) || !receipt) return null;

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
        onPress={() => (headline?.href ? router.push(headline.href as never) : open())}
        {...openPress.handlers}
        style={[
          { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
          openPress.style,
        ]}
      >
        {/* No tick on an answer. A checkmark means "this was applied", and
            nothing was: the user asked a question and this is the reply. The
            glyph that belongs there is the one for having spoken. */}
        <Ionicons
          name={isAnswer ? 'chatbubble-ellipses' : isUndone ? 'arrow-undo' : 'checkmark-circle'}
          size={17}
          color={isAnswer ? colors.accent : isUndone ? colors.textTertiary : colors.success}
        />
        <View style={{ flex: 1, gap: 1 }}>
          {/* An answer is set larger and given room to be an answer. Six lines
              rather than two, because a day briefing is three or four and the
              two-line clamp a receipt wants was cutting it mid-sentence — which
              is the one thing a reply may not do. Past six it scrolls in the
              sheet, which the chevron opens. */}
          <Txt
            variant={isAnswer ? 'body' : 'caption'}
            weight={isAnswer ? undefined : '600'}
            numberOfLines={isAnswer ? 6 : 2}
            tone={isUndone ? 'tertiary' : undefined}
          >
            {answerOnly ? reply : headline?.summary}
          </Txt>
          {applied.length > 1 && !isAnswer ? (
            <Txt variant="micro" tone="tertiary">
              and {applied.length - 1} more
            </Txt>
          ) : null}
          {alsoAnswered ? (
            <Txt testID="last-action-reply" variant="body" style={{ marginTop: 6 }}>
              {reply}
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
            {undo.isPending
              ? 'Undoing…'
              : undoesHeadline
                ? 'Undo'
                : /* Name it when it is not the row above. A bare "Undo" under a
                     sentence about something else is a button that lies. */
                  `Undo ${undoable.summary}`}
          </Txt>
        </AnimatedPressable>
      ) : null}
    </Animated.View>
  );
}

/**
 * Whether an utterance asked something as well as saying something. Loose on
 * purpose: a false positive shows the model's one sentence under a receipt,
 * and a false negative is the answer to a question going nowhere.
 */
export function asksSomething(transcript: string): boolean {
  return /\?|\b(when|what|what's|whats|who|whose|where|which|how|why|wondering|do i|did i|is there|are there)\b/i.test(
    transcript,
  );
}
