/**
 * Three dots that are actually working.
 *
 * The mic used to swap its glyph to Ionicons' `ellipsis-horizontal` while a
 * turn was in flight — three dots that never moved. On the one screen whose
 * entire job is telling you what is happening, the busiest moment in the app
 * was drawn as a static piece of punctuation, and a frozen indicator is worse
 * than none: it is indistinguishable from a hung process.
 *
 * A travelling wave rather than three independent blinks. Independent loops
 * drift out of phase within a few seconds and stop reading as one object;
 * one clock with a per-dot offset stays a wave for as long as the turn takes,
 * which on a slow model is a while.
 */
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

const COUNT = 3;
/** One full pass of the wave. Slow enough to read as breathing, not loading. */
const PERIOD_MS = 1100;
/**
 * How far apart the dots sit in the cycle, as a fraction of it.
 *
 * A third would put them exactly out of phase and the group would look like it
 * was rotating rather than travelling. A fifth keeps a visible crest moving
 * left to right with the tail still lit.
 */
const STAGGER = 0.2;

export function ThinkingDots({
  color,
  size = 10,
  gap = 7,
}: {
  color: string;
  size?: number;
  gap?: number;
}) {
  const reduced = useReducedMotion();
  const clock = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      // Still, not slower — a held frame is the honest answer to "no motion",
      // and it is held at full opacity so the dots are all still visible.
      cancelAnimation(clock);
      clock.value = 0;
      return;
    }
    clock.value = 0;
    clock.value = withRepeat(
      withTiming(1, { duration: PERIOD_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(clock);
  }, [reduced, clock]);

  return (
    <View
      style={[styles.row, { gap }]}
      // One object, not three. A screen reader walking three unlabelled dots
      // says nothing three times; the caption beside this carries the state.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: COUNT }, (_, index) => (
        <Dot key={index} clock={clock} index={index} color={color} size={size} reduced={reduced} />
      ))}
    </View>
  );
}

function Dot({
  clock,
  index,
  color,
  size,
  reduced,
}: {
  clock: ReturnType<typeof useSharedValue<number>>;
  index: number;
  color: string;
  size: number;
  reduced: boolean;
}) {
  const style = useAnimatedStyle(() => {
    if (reduced) return { opacity: 1, transform: [{ scale: 1 }] };
    // The wrap is what makes it a loop rather than a sawtooth: a dot whose
    // phase runs past 1 comes back at 0 instead of jumping.
    const phase = (clock.value + index * STAGGER) % 1;
    // Crest at a third of the way through, so the rise is quicker than the
    // fall — the same asymmetry a breath has, and it reads as effort.
    const lift = interpolate(phase, [0, 0.33, 1], [0, 1, 0], 'clamp');
    return {
      opacity: 0.35 + lift * 0.65,
      transform: [{ scale: 0.78 + lift * 0.34 }],
    };
  });

  return (
    <Animated.View
      style={[
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
