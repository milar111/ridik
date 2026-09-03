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
import { elevate, withAlpha } from '@/ui/shadow';
import { useVoiceStore } from '@/features/voice/store';

const DIAMETER = 138;

/**
 * The caption's box, reserved whatever is in it.
 *
 * Three lines of `caption` (17pt line height) plus a little air. Three because
 * two is not enough to be worth scrolling and four starts to crowd the receipt
 * below; past that the words scroll, which is the honest answer for a
 * dictation of any length.
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

  const spoken = SPOKEN[status] ?? null;
  const showingPartial = listening && Boolean(partial);
  const announce = spoken && !showingPartial;
  // The iOS half of the same thing. See `src/ui/a11y.ts` for why it is not both
  // on both.
  useAnnounceOnIOS(announce ? spoken : null);

  return (
    <View style={[styles.wrap, { gap: spacing.lg }]}>
      <View style={styles.stack}>
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

        A live transcript also stops being an `eyebrow`. That variant is a
        tracked, upper-cased *label*, which is right for "TAP TO SPEAK" and
        actively hostile to a paragraph: shouting is slower to read, and
        `letterSpacing` costs a character or two per line on Android, which
        cannot even measure it correctly. Your own words come back in the voice
        they were said in.
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
            variant={showingPartial ? 'caption' : 'eyebrow'}
            tone={showingPartial ? 'primary' : 'secondary'}
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
          The top edge, softened. Without it a sentence scrolled halfway is a
          line of text sliced through its own x-height, which reads as a
          rendering fault rather than as more words above. It is only painted
          while there is something to scroll, so the resting caption is not
          sitting under a gradient for no reason.
        */}
        {showingPartial ? <CaptionFade /> : null}
      </View>
    </View>
  );
}

/**
 * A soft top edge, built from bands rather than a gradient.
 *
 * `expo-linear-gradient` is not a dependency of this app and eighteen points of
 * fade is not a reason to make it one — a native module has to be prebuilt into
 * both platforms, and this is decoration. Six bands over 18pt, each 3pt tall,
 * is under the threshold where banding is visible at this size; the alternative
 * was an `react-native-svg` overlay, which is a whole rendering surface for the
 * same result.
 *
 * The colour is the ground, not black: this sits over a warm field and a grey
 * or black fade would read as a smudge. See "Nothing is neutral grey".
 */
function CaptionFade() {
  const { colors } = useTheme();
  return (
    <View pointerEvents="none" style={styles.captionFade}>
      {FADE_STEPS.map((alpha, index) => (
        <View
          key={index}
          style={{ height: FADE_BAND, backgroundColor: withAlpha(colors.bg, alpha) }}
        />
      ))}
    </View>
  );
}

/** Six 3pt bands. Opaque at the cut edge, gone by the time text is readable. */
const FADE_BAND = 3;
const FADE_STEPS = [1, 0.86, 0.66, 0.44, 0.24, 0.1];

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
  captionFade: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'column' },
});
