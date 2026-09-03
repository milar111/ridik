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
/** The pulse while a turn is in flight. Slower than a voice, faster than rest. */
const THINKING_MS = 2200;

/**
 * How long the source takes to cross and come back.
 *
 * Thinking is meant to be noticed. Idle is meant to be *felt* — long enough
 * that the movement is under the threshold of being seen happening, which is
 * the whole difference between an ambient field and a screensaver.
 */
const THINKING_DRIFT_MS = 2600;
const IDLE_DRIFT_MS = 18_000;

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

/**
 * The inner source, which is what actually gets hot.
 *
 * `thinking` was 0.45 and barely moved, which made the app's slowest moment its
 * quietest one — the field settled to a dim glow and sat there for as long as
 * the model took. Waiting is the state that most needs to look alive, because
 * it is the only one where the user has nothing to do but decide whether the
 * app has stopped. It is up, and it *pulses* on its own tempo (see
 * `THINKING_MS`) rather than sharing idle's slow breath.
 *
 * Still under `listening`. Listening is the user acting; thinking is the app
 * working, and an app that shouts louder than the person is the wrong way
 * round.
 */
const CORE: Record<HeatState, number> = {
  idle: 0,
  listening: 1,
  thinking: 0.72,
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

    // One value, three tempos — never three loops, so the field cannot jump
    // between two independent animations mid-phrase. Listening is quick because
    // it answers a voice; thinking sits between that and rest, which is what
    // makes it read as effort rather than as a heartbeat or a pause.
    const period = state === 'listening' ? 1500 : state === 'thinking' ? THINKING_MS : BREATH_MS;
    breath.value = withRepeat(
      withSequence(
        withTiming(1, { duration: period / 2, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: period / 2, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    );

    /*
      The source wanders, and how fast says what the app is doing.

      Idle used to be *still* — the field breathed in place and nothing moved
      sideways, which at a glance is a very large blurred circle sitting in the
      middle of the screen. What makes an ambient background read as expensive
      rather than as a static gradient is that it is never quite where it was,
      and the way to get that is a period long enough that nobody catches it
      moving: eighteen seconds out and eighteen back, against thinking's 2.6.
      You cannot watch it happen; you notice the screen is not the same.

      One shared value at three tempos, never three loops — the same rule the
      breath follows, and for the same reason: independent animations drift out
      of phase and the field stops reading as one object.
    */
    const wander =
      state === 'thinking' ? THINKING_DRIFT_MS : state === 'error' ? null : IDLE_DRIFT_MS;

    if (wander !== null) {
      drift.value = withRepeat(
        withSequence(
          withTiming(1, { duration: wander, easing: Easing.inOut(Easing.sin) }),
          withTiming(-1, { duration: wander, easing: Easing.inOut(Easing.sin) }),
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
    transform: [
      { scale: 0.9 + breath.value * 0.12 + core.value * 0.1 },
      // Only while thinking, and only a little: the source rides up and down
      // with its own breath, so the light appears to come from something
      // working rather than from a lamp on a dimmer. 14pt at the extremes.
      { translateY: state === 'thinking' ? (0.5 - breath.value) * 28 : 0 },
    ],
  }));

  const glow = useAnimatedStyle(() => {
    // Felt at the edge of vision, not watched. Listening is the only state
    // where the pulse is meant to be noticed.
    const amplitude = state === 'listening' ? 0.07 : state === 'thinking' ? 0.05 : 0.028;
    return {
      opacity: intensity.value,
      transform: [
        /*
          How far the source wanders, which is a different question from how
          fast. Thinking is meant to be noticed — this used to be half as far,
          which was below the threshold of registering at all, in the one state
          where the user is waiting and needs to see that something is
          happening. Idle goes further still, because it has eighteen seconds to
          get there and nothing on screen is competing with it; what makes that
          safe is the *speed*, not the distance.

          Both stay well inside the frame. A light that visibly crossed the page
          while you were reading would pull the eye off the text, and the
          receipt and the next event are both on this screen.
        */
        { translateX: drift.value * width * (state === 'thinking' ? 0.085 : 0.11) },
        // And a little vertically, on a different beat to the horizontal, so
        // the path is a slow figure rather than a line being retraced.
        { translateY: drift.value * breath.value * height * 0.03 },
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
