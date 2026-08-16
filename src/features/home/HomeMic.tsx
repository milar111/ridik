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

export function HomeMic() {
  const { colors, spacing } = useTheme();
  const reduced = useReducedMotion();

  const status = useVoiceStore((s) => s.status);
  const partial = useVoiceStore((s) => s.partial);
  const startListening = useVoiceStore((s) => s.startListening);
  const stopListening = useVoiceStore((s) => s.stopListening);
  const open = useVoiceStore((s) => s.open);

  const listening = status === 'listening';
  // 0.94 — the same travel this disc always had, now off the shared hook, so a
  // second tap landing inside the release carries the current velocity instead
  // of restarting the spring from wherever it had got to.
  const press = usePressScale({ scale: 0.94 });
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
          {...press.handlers}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
            if (listening) void stopListening();
            else void startListening();
          }}
          onLongPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
            open();
          }}
          style={[styles.disc, elevate('source'), { backgroundColor: colors.text }, press.style]}
        >
          <Ionicons name={icon} size={54} color={colors.surface} />
        </AnimatedPressable>
      </View>

      {/* One line, and it never grows into a transcript: the sheet is where a
          conversation happens. A home screen that reflowed while you spoke
          would move the button out from under your thumb. */}
      <Txt variant="eyebrow" tone="secondary" numberOfLines={1} style={styles.caption}>
        {(listening && partial ? partial : (CAPTION[status] ?? 'Tap to speak')).toUpperCase()}
      </Txt>
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
});
