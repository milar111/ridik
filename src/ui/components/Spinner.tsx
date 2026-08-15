/**
 * "Working on it", drawn once instead of twice.
 *
 * `ActivityIndicator` is a `UIActivityIndicatorView` on iOS — a ring of tapered
 * ticks fading round a circle — and a Material `CircularProgressIndicator` on
 * Android, a single arc of constant weight whose length grows and shrinks as it
 * sweeps. They are not the same drawing at the same size or the same speed, and
 * the only thing `color` can do is paint whichever one you got.
 *
 * Ticks were the right choice for this app anyway: the vernacular is a maker
 * lab's instruments, and a dial's engraving belongs here in a way that a
 * Material arc does not. Every part is a solid rounded rectangle, so nothing is
 * left to a platform's idea of how to stroke a curve.
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

import { useTheme } from '../ThemeProvider';

/** One turn. Slow enough to read as deliberate rather than frantic. */
const PERIOD_MS = 900;
const TICKS = 8;

export type SpinnerProps = {
  /** Diameter in points, or the two names `ActivityIndicator` used. */
  size?: 'small' | 'large' | number;
  color?: string;
  /** For the caller who has something better to say than "Loading". */
  accessibilityLabel?: string;
  testID?: string;
};

const DIAMETER: Record<'small' | 'large', number> = { small: 20, large: 36 };

export function Spinner({ size = 'small', color, accessibilityLabel = 'Loading', testID }: SpinnerProps) {
  const { colors, radius } = useTheme();
  const reduced = useReducedMotion();
  const turn = useSharedValue(0);

  const diameter = typeof size === 'number' ? size : DIAMETER[size];
  const tint = color ?? colors.accent;

  useEffect(() => {
    if (reduced) return;
    turn.value = 0;
    turn.value = withRepeat(withTiming(1, { duration: PERIOD_MS, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(turn);
  }, [reduced, turn]);

  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));

  const tickW = Math.max(2, Math.round(diameter * 0.11));
  const tickH = Math.max(5, Math.round(diameter * 0.27));
  // Half the leftover: the tick hangs from the rim inwards.
  const orbit = diameter / 2 - tickH / 2;

  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      // Indeterminate: saying "0%" would be a lie the screen reader repeats.
      accessibilityState={{ busy: true }}
      style={{ width: diameter, height: diameter }}
    >
      <Animated.View style={[styles.dial, spin]}>
        {Array.from({ length: TICKS }, (_, index) => (
          <View
            key={index}
            style={[
              styles.tick,
              {
                width: tickW,
                height: tickH,
                // Placed in points off the known diameter rather than by a
                // percentage and a negative margin: every tick's own centre has
                // to land exactly on the dial's, or the ring wobbles as it
                // turns, and rounding is the sort of thing two renderers do
                // differently at the half-pixel.
                top: (diameter - tickH) / 2,
                left: (diameter - tickW) / 2,
                borderRadius: radius.pill,
                backgroundColor: tint,
                // A comet rather than a ring: the ramp is what says which way
                // round it is going, and a still frame still reads as a dial.
                opacity: 0.15 + (0.85 * index) / (TICKS - 1),
                transform: [{ rotate: `${(index * 360) / TICKS}deg` }, { translateY: -orbit }],
              },
            ]}
          />
        ))}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  dial: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  tick: { position: 'absolute' },
});
