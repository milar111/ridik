/**
 * The source.
 *
 * The disc is the darkest object on the screen and it never changes colour.
 * That is the whole idea: it is the element, and what it does is heat the room
 * — the field around it is the state, not the button. Lighting the button up
 * instead was the first attempt and it failed on contact with the device: an
 * ember disc on a flooded ember field is nearly invisible, so pressing it made
 * the one control on the screen harder to see.
 *
 * What carries the state at the button is a ring, which reads at any field
 * temperature because it is a hard edge rather than a fill.
 *
 * Same store and the same gestures as the floating dock, so there is one voice
 * session in the app rather than two that can disagree about whether it is on.
 */
import { useEffect, useRef } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { useTheme } from '@/ui/ThemeProvider';
import { useAnnounceOnIOS } from '@/ui/a11y';
import { Txt } from '@/ui/components/Text';
import { ThinkingDots } from '@/ui/components/ThinkingDots';
import { fade } from '@/ui/motion';
// The shared `AnimatedPressable`, not a second one made here: two
// `createAnimatedComponent` calls produce two component *types*, and the app
// only needs one.
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import { elevate } from '@/ui/shadow';
import { useTourTarget } from '@/features/tour/TourContext';
import { useVoiceStore } from '@/features/voice/store';

const DIAMETER = 138;

/**
 * The caption's box, reserved whatever is in it.
 *
 * The number is unchanged from when the line was set larger, deliberately: it
 * is what keeps the disc under your thumb in every state, and holding it while
 * the type got smaller simply buys a fourth line of `eyebrow` (14pt line
 * height) instead of a third of `caption`. Past that the words scroll, which
 * is the honest answer for a dictation of any length.
 */
const CAPTION_HEIGHT = 58;

/**
 * How long the disc has to be held before it turns into a keyboard.
 *
 * Also passed to `delayLongPress`, so the ring finishing and the sheet opening
 * are the same instant. Two numbers here would mean a ring that completes and
 * then waits, or a sheet that opens over a half-drawn one — and a progress
 * indicator that lies about its own threshold is worse than none.
 */
const HOLD_MS = 550;

/**
 * The resting caption, and the only place the keyboard is advertised.
 *
 * Typing used to have a pill beside the disc. It was removed because a second
 * control next to the one control makes the screen a choice rather than an
 * instrument — but the reason it existed has not gone away: a long press with
 * no affordance is undiscoverable, and the people most likely to need typing
 * are the ones who cannot talk to a phone right now and will not go hunting.
 * So the gesture keeps an affordance; it is a word rather than a button, on a
 * line that was already there and already read.
 */
const IDLE_CAPTION = 'Tap to speak · hold to type';

/* The same sentence for a screen reader: sentence case rather than the drawn
   line's shouting, and "hold" spelled out as the instruction it is. */
const SPOKEN_IDLE = 'Tap to speak, or hold to type instead.';

/** What the button is doing, in the fewest words that are still true. */
const CAPTION: Record<string, string> = {
  listening: 'Listening · tap to send',
  // Only ever seen when the recogniser returned nothing to show: with words in
  // hand the caption keeps *them* up through this state — see `showingPartial`.
  // Without it, the half-second after a silent utterance fell back to the idle
  // label, which is the app saying "tap to speak" at somebody who just had.
  sending: 'Sending',
  thinking: 'Working on it',
  speaking: 'Speaking',
  error: 'Tap to try again',
};

/**
 * The same four states, said rather than drawn.
 *
 * Sentence case, because the caption is upper-cased for the eye and a screen
 * reader should not be handed shouting. Punctuated, because "Listening tap to
 * send" is one sentence spoken flat and two read.
 *
 * `idle` is deliberately absent. It is the resting state, it is what focus on
 * the mic already reads out, and announcing it would mean talking over the
 * screen's own arrival on every launch — the state changes worth interrupting
 * for are the ones that start and finish a turn.
 */
const SPOKEN: Record<string, string> = {
  listening: 'Listening. Tap to send.',
  sending: 'Sending.',
  thinking: 'Working on it.',
  speaking: 'Ridik is speaking.',
  error: 'That did not work. Tap to try again.',
};

export function HomeMic() {
  const { colors, spacing } = useTheme();
  const reduced = useReducedMotion();

  const status = useVoiceStore((s) => s.status);
  const partial = useVoiceStore((s) => s.partial);
  const startListening = useVoiceStore((s) => s.startListening);
  const stopListening = useVoiceStore((s) => s.stopListening);
  const startTyping = useVoiceStore((s) => s.startTyping);

  const listening = status === 'listening';
  // 0.94 — the same travel this disc always had, now off the shared hook, so a
  // second tap landing inside the release carries the current velocity instead
  // of restarting the spring from wherever it had got to.
  const press = usePressScale({ scale: 0.94 });
  const lit = useSharedValue(0);
  const ring = useSharedValue(0);
  // 0→1 across HOLD_MS while the disc is held. The only thing that says a hold
  // is doing something before it has done it.
  const hold = useSharedValue(0);

  useEffect(() => {
    lit.value = fade(listening ? 1 : 0);
    if (listening && !reduced) {
      ring.value = withRepeat(
        withTiming(1, { duration: 1500, easing: Easing.out(Easing.quad) }),
        -1,
        false,
      );
    } else {
      cancelAnimation(ring);
      ring.value = fade(0);
    }
  }, [listening, reduced, lit, ring]);

  // A hard edge travelling outward, fading as it goes. Reads at any field
  // temperature, which a change of fill colour does not.
  const ringStyle = useAnimatedStyle(() => ({
    opacity: lit.value * (1 - ring.value) * 0.9,
    transform: [{ scale: 1 + ring.value * 0.42 }],
  }));

  /**
   * The hold, made visible.
   *
   * A collar that closes onto the disc rather than a bar that fills: the disc
   * is round and under a thumb, so the only free direction is outward, and a
   * shape arriving at the edge you are already touching reads as "nearly" in a
   * way a distant progress bar does not. It starts wide and loose and tightens
   * to the rim exactly as the threshold is met, so the moment the keyboard
   * appears is the moment the ring lands — see HOLD_MS.
   *
   * `colors.text` and not the ember: this sits on the hottest part of the
   * field, where an accent-coloured hairline disappears.
   */
  const holdStyle = useAnimatedStyle(() => ({
    opacity: hold.value * 0.85,
    transform: [{ scale: 1.5 - hold.value * 0.46 }],
  }));

  const startHold = () => {
    press.onPressIn();
    /*
      The press is confirmed by touch, not only by the collar.

      The collar is the only thing saying a hold is under way, and it is not
      drawn under Reduce Motion — so for those users pressing and waiting out
      the 550ms produced no feedback of any kind, which is indistinguishable
      from a tap that missed the button. That is the exact failure the collar
      was added to prevent, left open for the people least able to tolerate it.

      A haptic is the right answer rather than drawing the collar anyway: it is
      not motion, so it does not defeat the setting, and it says the one thing
      that was missing — *the button has you*. It is also what the hardware this
      interaction was modelled on does, and for the same reason: the Stream ring
      buzzes on press to confirm the mic is live, because a device you are not
      looking at has to confirm by touch.
    */
    void Haptics.selectionAsync().catch(() => {});
    if (reduced) return;
    hold.value = 0;
    hold.value = withTiming(1, { duration: HOLD_MS, easing: Easing.linear });
  };

  // Cancelled *and* completed both land here — a hold that succeeded has the
  // sheet over it, so leaving the collar drawn would park it under the sheet
  // and reveal it again on dismiss.
  const endHold = () => {
    press.onPressOut();
    cancelAnimation(hold);
    hold.value = fade(0);
  };

  /*
    Working is the one state that is not a glyph.

    It was `ellipsis-horizontal` — three dots that never moved, on the one
    screen whose job is saying what is happening, at the only moment the user
    has nothing to do but wait. A still indicator is indistinguishable from a
    hung app, which is exactly the doubt it was there to answer.
  */
  const working = status === 'thinking';
  const icon: keyof typeof Ionicons.glyphMap = status === 'speaking' ? 'volume-high' : 'mic';

  /**
   * The caption is the state, and while you are speaking it is the transcript.
   *
   * That is why the live region below is switched off for exactly that case: a
   * region that re-reads on every content change would interrupt TalkBack on
   * every syllable of your own sentence, which is unusable in a way that no
   * announcement is worth. The words arriving are still there to be read by
   * touch; what is announced is the state that changed.
   */
  const captionScroll = useRef<ScrollView>(null);

  const micTarget = useTourTarget('mic');

  const spoken = SPOKEN[status] ?? null;
  /*
    The words stay up while the utterance is being finalised, not just while it
    is being heard.

    `sending` is the window between the user finishing and the turn starting —
    the recogniser is allowed 2.5s to hand over a final result. Dropping the
    caption at the moment the finger lifts put the resting label back over a
    sentence the user was still reading, and then a receipt arrived from
    nowhere. Holding the last partial through `sending` makes the hand-off
    continuous: the words you spoke stay on screen until the thing they did
    replaces them.
  */
  const showingPartial = (listening || status === 'sending') && Boolean(partial);
  const announce = spoken && !showingPartial;
  // The iOS half of the same thing. See `src/ui/a11y.ts` for why it is not both
  // on both.
  useAnnounceOnIOS(announce ? spoken : null);

  return (
    <View style={[styles.wrap, { gap: spacing.lg }]}>
      {/* The guided tour rings the disc, not the whole mic block: the caption
          under it is a different thing and a ring around both says so. Inert
          outside a `TourProvider`, so this component's own tests know nothing
          about the tour. */}
      <View style={styles.stack} {...micTarget}>
        <Animated.View
          pointerEvents="none"
          style={[styles.ring, { borderColor: colors.text }, ringStyle]}
        />
        <Animated.View
          testID="home-mic-hold"
          pointerEvents="none"
          style={[styles.ring, { borderColor: colors.text }, holdStyle]}
        />
        <AnimatedPressable
          testID="home-mic"
          accessibilityRole="button"
          accessibilityLabel={listening ? 'Stop listening' : 'Start voice capture'}
          accessibilityHint="Long press to type instead"
          // Working and speaking are a swapped glyph and a moving field —
          // nothing a screen reader can see. `busy` is the same fact in the one
          // vocabulary both platforms already speak.
          accessibilityState={{ busy: status === 'thinking' || status === 'speaking' }}
          onPressIn={startHold}
          onPressOut={endHold}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
            if (listening) void stopListening();
            else void startListening();
          }}
          delayLongPress={HOLD_MS}
          onLongPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
            startTyping();
          }}
          style={[styles.disc, elevate('source'), { backgroundColor: colors.text }, press.style]}
        >
          {working ? (
            <ThinkingDots color={colors.surface} size={13} gap={9} />
          ) : (
            <Ionicons name={icon} size={54} color={colors.surface} />
          )}
        </AnimatedPressable>
      </View>

      {/*
        A fixed box, and the words move inside it.

        This was one elided line, on the reasoning that a caption which grew
        would push the button out from under your thumb. The reasoning was
        right and the conclusion was wrong: a long sentence became "BOOK TWO
        HOURS FOR THE ROBOT…", so the one moment you most want to see what was
        heard is the one moment it is hidden. The fix is not to let it grow —
        it is to reserve the space up front. `CAPTION_HEIGHT` is the same
        whatever is in it, so nothing on this screen ever moves, and a sentence
        longer than three lines scrolls with its top going under the fade.

        One typographic treatment, not two. The transcript used to be set in
        `caption` — larger, untracked, in the body face — on the reasoning that
        `eyebrow` is a *label* variant and shouting a paragraph is slower to
        read. That reasoning survives in exactly one place: the words are not
        upper-cased. Everything else about it was wrong on a real screen, where
        the caption slot visibly changed typeface, size and weight the instant
        you started talking, so the calmest moment in the app became the one
        where the type jumped. The Android objection to `letterSpacing` does
        not apply here either — `styles.caption` already gives it an explicit
        width and centres it, which is the documented remedy.
      */}
      <View testID="home-mic-caption-box" style={styles.captionBox}>
        <ScrollView
          ref={captionScroll}
          scrollEnabled={showingPartial}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => {
            // The newest words are the ones worth seeing, so the box tracks the
            // bottom rather than the top. `animated` because the jump between
            // two partials is small and a hard cut reads as a flicker.
            if (showingPartial) captionScroll.current?.scrollToEnd({ animated: true });
          }}
          contentContainerStyle={styles.captionContent}
        >
          <Txt
            testID="home-mic-caption"
            variant="eyebrow"
            tone="secondary"
            style={styles.caption}
            // Android's half of "the state changed" — and off while the partial
            // transcript is what this line is showing.
            accessibilityLiveRegion={announce ? 'polite' : 'none'}
            // What is drawn is upper-cased at rest; that is not something to
            // read out. What is spoken is the sentence, or the words heard so
            // far in full.
            accessibilityLabel={showingPartial ? partial : (spoken ?? SPOKEN_IDLE)}
          >
            {showingPartial ? partial : (CAPTION[status] ?? IDLE_CAPTION).toUpperCase()}
          </Txt>
        </ScrollView>
        {/*
          There is no fade here any more, and the reason it had to go is the
          one thing its own docblock got wrong. It was six bands of
          `colors.bg`, argued as "the ground, not black" — but on *this* screen
          the ground is not `colors.bg`. It is `HeatField`, and the caption sits
          directly over the ember core, so an opaque brown-black strip was
          painted across the brightest part of the screen at precisely the
          moment the user was talking to it. Any opaque colour is wrong over an
          animated gradient; the only correct version is a mask, which needs
          `react-native-svg` whose mask support differs enough between the
          platforms to come out a different size on each — eighteen points of
          softening is not worth that. A top line sliced by the scroll edge is
          a far smaller cost than a bar over the hero.
        */}
      </View>
    </View>
  );
}


const styles = StyleSheet.create({
  wrap: { alignItems: 'center', width: 300 },
  stack: { alignItems: 'center', justifyContent: 'center' },
  ring: {
    position: 'absolute',
    width: DIAMETER,
    height: DIAMETER,
    borderRadius: DIAMETER / 2,
    borderWidth: 2,
  },
  disc: {
    width: DIAMETER,
    height: DIAMETER,
    borderRadius: DIAMETER / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /*
    Reserved, not earned. The height is the same at rest and mid-sentence, so
    the disc above it cannot move while somebody is talking — which was the
    whole reason the caption was pinned to one line in the first place.
  */
  captionBox: { height: CAPTION_HEIGHT, width: '100%', overflow: 'hidden' },
  // Centred *within* the box while short, so the resting hint sits on the same
  // line it always did rather than clinging to the top of a taller container.
  captionContent: { flexGrow: 1, justifyContent: 'center' },
  // Full width and centred by `textAlign`, never shrink-wrapped: Android does
  // not count `letterSpacing` when it measures a line, so a tracked label sized
  // to its own content gets ellipsised a character or two early — "TAP TO S…".
  caption: { textAlign: 'center', width: '100%' },
});
