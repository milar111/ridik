/**
 * The ground, lit by the microphone.
 *
 * This is the one place the app spends its boldness. Everywhere else is quiet
 * on purpose so that this can carry the whole screen: a radial field whose
 * light source sits exactly where the mic does, so pressing the button visibly
 * changes the room rather than just the button.
 *
 * It has four states and they are the voice pipeline's, not decoration:
 *
 *   idle       breathes, slowly, so a screen with one control is not dead
 *   listening  floods — the source runs hotter and reaches past the edges
 *   thinking   drifts, the source wandering slightly, because something is
 *              happening that has no progress bar honest enough to show
 *   error      cools back, fast, and stops moving
 *
 * The gradient itself never changes. What moves is the layer holding it —
 * scale, opacity, a little translation — because a transform is GPU work,
 * where re-rasterising a gradient every frame is not. It also sidesteps the
 * thing that does not work at all: Reanimated cannot animate `Stop` or
 * `RadialGradient`, which live in `<Defs>` and render no host view to attach to.
 */
import { useEffect } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

import { BREATH_MS, FADE } from './motion';
import { useTheme } from './ThemeProvider';

export type HeatState = 'idle' | 'listening' | 'thinking' | 'error';

/**
 * How far the field reaches, as a multiple of its natural size. Listening is
 * the only state that pushes the falloff past the screen edges, which is what
 * makes it read as flooding the room rather than as a circle getting bigger.
 */
/**
 * How far the base field reaches. Barely moves between states, and that is the
 * correction from the first version: scaling this up to "flood" the screen just
 * drags the gradient's falloff over everything, so the whole page went a flat
 * mid-brown and the app looked *worse* at the exact moment it was being used.
 * Heat is carried by `CORE` below instead — a tighter, brighter source — which
 * leaves the peach edges intact and keeps the readout legible.
 */
const REACH: Record<HeatState, number> = {
  idle: 0.80,
  listening: 0.86,
  thinking: 0.84,
  error: 0.66,
};

const INTENSITY: Record<HeatState, number> = {
  idle: 0.92,
  listening: 1,
  thinking: 0.96,
  error: 0.6,
};

/** The inner source, which is what actually gets hot. */
const CORE: Record<HeatState, number> = {
  idle: 0,
  listening: 1,
  thinking: 0.45,
  error: 0,
};

export function HeatField({
  state = 'idle',
  /** Where the light comes from, as a fraction of screen height. The mic. */
  originY = 0.58,
}: {
  state?: HeatState;
  originY?: number;
}) {
  const { heat, colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const reduced = useReducedMotion();

  // Generous, so that even at the smallest reach the falloff is off-screen and
  // the field has no visible circular edge.
  const size = Math.hypot(width, height) * 1.9;

  const reach = useSharedValue(REACH[state]);
  const intensity = useSharedValue(INTENSITY[state]);
  const core = useSharedValue(CORE[state]);
  const breath = useSharedValue(0);
  const drift = useSharedValue(0);

  useEffect(() => {
    reach.value = withTiming(REACH[state], { duration: 620, easing: Easing.out(Easing.cubic) });
    intensity.value = withTiming(INTENSITY[state], FADE);
    core.value = withTiming(CORE[state], { duration: 460, easing: Easing.out(Easing.cubic) });
  }, [state, reach, intensity, core]);

  useEffect(() => {
    if (reduced) {
      // Still, not slower. A held frame is the honest answer to "no motion".
      cancelAnimation(breath);
      cancelAnimation(drift);
      breath.value = 0;
      drift.value = 0;
      return;
    }

    // Listening reuses the same value at a quicker tempo, so the field never
    // jumps between two independent loops mid-phrase.
    const period = state === 'listening' ? 1500 : BREATH_MS;
    breath.value = withRepeat(
      withSequence(
        withTiming(1, { duration: period / 2, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: period / 2, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    );

    if (state === 'thinking') {
      drift.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }),
          withTiming(-1, { duration: 2600, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        true,
      );
    } else {
      cancelAnimation(drift);
      drift.value = withTiming(0, FADE);
    }

    return () => {
      cancelAnimation(breath);
      cancelAnimation(drift);
    };
  }, [state, reduced, breath, drift]);

  // Sized off the mic rather than the screen: this is the element getting hot,
  // so its scale should read as belonging to the button, not to the page.
  const coreSize = Math.min(width, height) * 0.95;

  const coreStyle = useAnimatedStyle(() => ({
    opacity: core.value * (0.72 + breath.value * 0.28),
    transform: [{ scale: 0.9 + breath.value * 0.12 + core.value * 0.1 }],
  }));

  const glow = useAnimatedStyle(() => {
    // Felt at the edge of vision, not watched. Listening is the only state
    // where the pulse is meant to be noticed.
    const amplitude = state === 'listening' ? 0.07 : 0.028;
    return {
      opacity: intensity.value,
      transform: [
        // Only `thinking` moves the source sideways, and barely: a light that
        // wandered while you were reading would pull the eye off the text.
        { translateX: drift.value * width * 0.05 },
        { scale: reach.value * (1 + breath.value * amplitude) },
      ],
    };
  });

  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      // Atmosphere, not content. A screen reader announcing "image" here would
      // be reading out the wallpaper.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {/* The cooled edge of the same fire, so the corners the glow cannot reach
          are the right temperature rather than a hard seam. */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]} />
      <Animated.View
        style={[
          {
            position: 'absolute',
            width: size,
            height: size,
            left: width / 2 - size / 2,
            top: height * originY - size / 2,
          },
          glow,
        ]}
      >
        <Svg width={size} height={size}>
          <Defs>
            <RadialGradient id="ridik-heat" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={heat.core} stopOpacity="1" />
              <Stop offset="0.22" stopColor={heat.mid} stopOpacity="0.92" />
              <Stop offset="0.44" stopColor={heat.edge} stopOpacity="0.62" />
              {/* Fades to nothing rather than to the rim colour: a gradient that
                  ends on an opaque stop leaves a visible disc edge the moment
                  the layer is scaled past the screen. */}
              <Stop offset="0.7" stopColor={heat.edge} stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx={size / 2} cy={size / 2} r={size / 2} fill="url(#ridik-heat)" />
        </Svg>
      </Animated.View>

      {/* The element itself coming up to temperature. Sits over the base field
          and only ever brightens the middle, so the edges of the screen stay
          the peach they were and the type over them keeps its contrast. */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            width: coreSize,
            height: coreSize,
            left: width / 2 - coreSize / 2,
            top: height * originY - coreSize / 2,
          },
          coreStyle,
        ]}
      >
        <Svg width={coreSize} height={coreSize}>
          <Defs>
            <RadialGradient id="ridik-core" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={heat.core} stopOpacity="1" />
              <Stop offset="0.45" stopColor={heat.core} stopOpacity="0.5" />
              <Stop offset="1" stopColor={heat.core} stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx={coreSize / 2} cy={coreSize / 2} r={coreSize / 2} fill="url(#ridik-core)" />
        </Svg>
      </Animated.View>
    </View>
  );
}
