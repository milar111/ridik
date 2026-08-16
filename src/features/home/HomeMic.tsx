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
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
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
import { fade } from '@/ui/motion';
// The shared `AnimatedPressable`, not a second one made here: two
// `createAnimatedComponent` calls produce two component *types*, and the app
// only needs one.
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import { elevate } from '@/ui/shadow';
import { useVoiceStore } from '@/features/voice/store';

const DIAMETER = 138;

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
  const { colors, radius, spacing } = useTheme();
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
  const typePress = usePressScale({ scale: 0.94 });
  const lit = useSharedValue(0);
  const ring = useSharedValue(0);

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

  const icon: keyof typeof Ionicons.glyphMap =
    status === 'thinking' ? 'ellipsis-horizontal' : status === 'speaking' ? 'volume-high' : 'mic';

  /**
   * The caption is the state, and while you are speaking it is the transcript.
   *
   * That is why the live region below is switched off for exactly that case: a
   * region that re-reads on every content change would interrupt TalkBack on
   * every syllable of your own sentence, which is unusable in a way that no
   * announcement is worth. The words arriving are still there to be read by
   * touch; what is announced is the state that changed.
   */
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
        <AnimatedPressable
          testID="home-mic"
          accessibilityRole="button"
          accessibilityLabel={listening ? 'Stop listening' : 'Start voice capture'}
          accessibilityHint="Long press to type instead"
          // Working and speaking are a swapped glyph and a moving field —
          // nothing a screen reader can see. `busy` is the same fact in the one
          // vocabulary both platforms already speak.
          accessibilityState={{ busy: status === 'thinking' || status === 'speaking' }}
          {...press.handlers}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
            if (listening) void stopListening();
            else void startListening();
          }}
          onLongPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
            startTyping();
          }}
          style={[styles.disc, elevate('source'), { backgroundColor: colors.text }, press.style]}
        >
          <Ionicons name={icon} size={54} color={colors.surface} />
        </AnimatedPressable>
      </View>

      {/* One line, and it never grows into a transcript: the sheet is where a
          conversation happens. A home screen that reflowed while you spoke
          would move the button out from under your thumb. */}
      <Txt
        testID="home-mic-caption"
        variant="eyebrow"
        tone="secondary"
        numberOfLines={1}
        style={styles.caption}
        // Android's half of "the state changed" — and off while the partial
        // transcript is what this line is showing.
        accessibilityLiveRegion={announce ? 'polite' : 'none'}
        // The drawn line is upper-cased and elided to one line; neither is
        // something to read out. What is spoken is the sentence, or the words
        // heard so far in full.
        accessibilityLabel={showingPartial ? partial : (spoken ?? 'Tap to speak.')}
      >
        {(listening && partial ? partial : (CAPTION[status] ?? 'Tap to speak')).toUpperCase()}
      </Txt>

      {/*
        The visible way to type.

        It was a long-press on the disc and nothing else — a gesture with no
        affordance, which is exactly the wrong thing to hide behind for the
        people who most need it: nobody talks to a phone on a train, and an
        infrequent user who cannot see a way in decides the app is not for them
        rather than discovering one.

        Absolutely positioned, and that is not a detail. The disc is fixed
        under the thumb by design, so anything added beside it must take no
        part in the layout that centres it — a control in flow would push the
        one control the product is built around a few points up the screen.
        Anchored to the caption's own line, where it reads as part of the same
        sentence, and hidden once a session is live, when the caption is the
        transcript and this is a second thing to read.
      */}
      {status === 'idle' ? (
        <AnimatedPressable
          testID="home-type"
          accessibilityRole="button"
          accessibilityLabel="Type instead of speaking"
          {...typePress.handlers}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
            startTyping();
          }}
          hitSlop={10}
          style={[
            styles.type,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderRadius: radius.pill,
            },
            typePress.style,
          ]}
        >
          <Ionicons name="create-outline" size={13} color={colors.textSecondary} />
          {/* Explicit width and centred: Android does not count `letterSpacing`
              when it measures a line, so a tracked label sized to its own
              content is ellipsised a character early. */}
          <Txt variant="eyebrow" tone="secondary" style={styles.typeLabel}>
            TYPE
          </Txt>
        </AnimatedPressable>
      ) : null}
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
  // Full width and centred by `textAlign`, never shrink-wrapped: Android does
  // not count `letterSpacing` when it measures a line, so a tracked label sized
  // to its own content gets ellipsised a character or two early — "TAP TO S…".
  caption: { textAlign: 'center', minHeight: 16, width: '100%' },
  // Out of the flow entirely, on the caption's line at the right edge of the
  // 300pt column: the caption is centred text and short at rest, so the two
  // never meet. `bottom: 0` grows it upward into the gap above rather than
  // downward into the receipt.
  type: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: StyleSheet.hairlineWidth,
  },
  typeLabel: { width: 34, textAlign: 'center' },
});
