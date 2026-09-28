/**
 * The hooks that go with `./motion` — the tokens made usable in a component.
 *
 * Separate from `motion.ts` because a token and a hook are different kinds of
 * thing: a token is a value anything may read, a hook has a lifecycle, an
 * ordering contract and a React import behind it. Keeping them apart means the
 * vocabulary file stays a page of numbers you can read in one go, and means
 * this file can pull in `react-native` (for `AnimatedPressable`) without every
 * consumer of a duration paying for it.
 *
 * Everything here is built from `motion.ts` and nothing here invents a new
 * curve. Two rules the whole file obeys, because they are the two ways motion
 * has broken in this app before:
 *
 *  - **Nothing uses `entering`/`exiting`.** These hooks are written to work
 *    inside a React Native `Modal`, which is a separate native window where
 *    Reanimated's layout animations do not reliably get the layout pass they
 *    need. A shared value driven from an effect works in both places, so that
 *    is the only mechanism used — see `SheetCard`, which is this pattern by
 *    hand. The one exception is `useStaggeredEntry`, which *returns* an
 *    entering builder and says in its own doc that it is outside-a-Modal only.
 *  - **Reduced motion is a branch, not a shorter animation.** Anything that
 *    merely travels leans on `reduceMotion: ReduceMotion.System` in the config.
 *    Anything that loops or pops is switched off outright.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type {
  EntryOrExitLayoutType,
  WithSpringConfig,
  WithTimingConfig,
} from 'react-native-reanimated';

import { BREATH_MS, FADE, SPRING_ENTER, SPRING_TAP, stagger } from './motion';

/**
 * A `Pressable` that can take an animated style.
 *
 * `createAnimatedComponent` must be called once, at module scope — calling it
 * in a render makes a new component type on every pass, which unmounts and
 * remounts the subtree and loses the press that was in flight. One shared
 * export is a footgun removed from fifty call sites.
 */
export const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** How far a pressed surface sinks. Small: this is a hint, not a gesture. */
const PRESS_SCALE = 0.96;

export type PressScaleOptions = {
  /** Pressed scale. 0.96 by default; go smaller only for a small target. */
  scale?: number;
  /** Pressed opacity, if the surface should dim too. Left alone when unset. */
  opacity?: number;
  /** A control that cannot be used should not answer the finger. */
  disabled?: boolean;
  /** Override the profile. Almost nothing should: a press is `snappy`. */
  spring?: WithSpringConfig;
};

/**
 * Press feedback as a spring instead of an instant opacity drop.
 *
 * `opacity: pressed ? 0.6 : 1` is the app's most-repeated line and it is the
 * reason a screen full of correct components can still feel like a web page:
 * the surface does not acknowledge the finger, it just dims between two frames.
 * A scale on `SPRING_TAP` costs the same at the call site and reads as contact.
 *
 * Interruptible by construction — a press that lands while the release is still
 * springing back reassigns the shared value mid-flight, so Reanimated carries
 * the current position *and velocity* into the new spring rather than jumping.
 *
 * ```tsx
 * const press = usePressScale();
 * <AnimatedPressable {...press.handlers} style={[styles.row, press.style]} />
 * ```
 *
 * Wrap in an `Animated.View` instead when the pressable's own style is doing
 * something the transform would fight — a shadow, or a layout the parent reads.
 *
 * Under reduced motion `SPRING_TAP` lands the scale in one frame rather than
 * dropping it: the feedback survives, the travel does not. That is the right
 * trade here and only here — this is contact, not something crossing the
 * screen, and a control that stops acknowledging the finger is a broken one.
 */
export function usePressScale(options: PressScaleOptions = {}) {
  const { scale = PRESS_SCALE, opacity, disabled = false, spring = SPRING_TAP } = options;
  const press = useSharedValue(0);

  const style = useAnimatedStyle(() => {
    const transform = [{ scale: 1 - press.value * (1 - scale) }];
    // Only written when asked for: a style that always sets `opacity: 1` would
    // silently override a row that dims itself for another reason (an agenda
    // row in the past, a disabled control).
    return opacity == null ? { transform } : { opacity: 1 - press.value * (1 - opacity), transform };
  });

  const onPressIn = useCallback(() => {
    if (!disabled) press.set(withSpring(1, spring));
  }, [disabled, press, spring]);

  const onPressOut = useCallback(() => {
    press.set(withSpring(0, spring));
  }, [press, spring]);

  // `handlers` is spreadable onto a Pressable; the two are also returned flat
  // for a call site that already spreads something else. Memoised so spreading
  // it does not hand a memoised child two new props on every render.
  const handlers = useMemo(() => ({ onPressIn, onPressOut }), [onPressIn, onPressOut]);
  return { style, handlers, onPressIn, onPressOut };
}

/**
 * A 0→1 shared value that runs once, on mount.
 *
 * The primitive under every in-`Modal` entrance in the app. Returned raw so a
 * caller can drive whatever it likes off it; `useMountRise` and `useMountPop`
 * are the two shapes worth sharing.
 */
export function useMountProgress(spring: WithSpringConfig = SPRING_ENTER) {
  const progress = useSharedValue(0);
  // Captured at mount rather than tracked: an entrance runs once, and a caller
  // passing an inline config object would otherwise restart it on every render.
  const [config] = useState(spring);

  useEffect(() => {
    // The spring carries `ReduceMotion.System`, so this resolves to the settled
    // frame rather than a faster slide for anyone who asked the OS to stop.
    progress.value = withSpring(1, config);
  }, [progress, config]);

  return progress;
}

/**
 * Rise and fade in, once, on mount — the bottom-sheet entrance.
 *
 * `SheetCard` is this by hand and is the reference implementation; use this for
 * anything sheet-shaped that is not going through `SheetCard`. Default travel
 * matches it. `SPRING_HEAVY` is the right profile for a full-width surface, but
 * the default stays `SPRING_ENTER` so adopting this hook cannot silently change
 * how a sheet that already exists arrives.
 */
export function useMountRise(options: { travel?: number; spring?: WithSpringConfig } = {}) {
  const { travel = 28, spring = SPRING_ENTER } = options;
  const progress = useMountProgress(spring);

  return useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * travel }],
  }));
}

/**
 * Scale and fade in, once, on mount — the centred-dialog entrance.
 *
 * A dialog has no edge to come from: it is already in the middle of the screen,
 * so sliding it means picking a direction that means nothing. Growing the last
 * few per cent reads as it arriving in front of the page instead.
 */
export function useMountPop(options: { from?: number; spring?: WithSpringConfig } = {}) {
  const { from = 0.94, spring = SPRING_ENTER } = options;
  const progress = useMountProgress(spring);

  return useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: from + (1 - from) * progress.value }],
  }));
}

/**
 * An ambient loop between two values, held still under reduced motion.
 *
 * Returned as a shared value rather than a style because the callers map it to
 * different properties — a skeleton to opacity, a mic to scale. `active` is
 * what turns it off: cancelling and settling, never leaving a half-finished
 * frame behind. A loop is exactly the case `reduceMotion` on a config cannot
 * handle, because a repeat that resolves instantly still repeats.
 *
 * `from` is also the held frame, so it should be the value the surface ought to
 * rest at — a skeleton that breathes between full and dim is
 * `usePulse({ from: 1, to: 0.5 })`, not the other way round, or switching it
 * off would leave the page greyed out.
 */
export function usePulse(
  options: { from?: number; to?: number; ms?: number; active?: boolean } = {},
) {
  const { from = 0, to = 1, ms = BREATH_MS, active = true } = options;
  const reduced = useReducedMotion();
  const value = useSharedValue(from);

  useEffect(() => {
    if (!active || reduced) {
      cancelAnimation(value);
      value.value = withTiming(from, FADE);
      return;
    }

    value.value = from;
    value.value = withRepeat(
      withTiming(to, {
        duration: ms,
        easing: Easing.inOut(Easing.quad),
        reduceMotion: ReduceMotion.System,
      }),
      -1,
      true,
    );

    return () => cancelAnimation(value);
  }, [active, reduced, from, to, ms, value]);

  return value;
}

/**
 * A one-shot overshoot the moment a flag becomes true — the tick, the log.
 *
 * Ticking a task and logging a habit are the only two things this app asks you
 * to do every day, and both currently change four properties in one frame with
 * nothing to mark that anything happened. The pop is the receipt.
 *
 * Deliberately silent on mount: a list of already-done rows must not all jump
 * when the screen opens, and it must not pop when the flag goes back to false.
 */
export function useCheckPop(on: boolean, options: { peak?: number } = {}) {
  const { peak = 1.22 } = options;
  const scale = useSharedValue(1);
  const previous = useRef(on);

  useEffect(() => {
    const was = previous.current;
    previous.current = on;
    if (!on || was) return;

    // Both steps carry `ReduceMotion.System`, so the sequence resolves straight
    // to 1 — a still frame, not a quick jab — when the OS has asked for it.
    scale.value = withSequence(
      withTiming(peak, {
        duration: 110,
        easing: Easing.out(Easing.quad),
        reduceMotion: ReduceMotion.System,
      }),
      withSpring(1, SPRING_ENTER),
    );
  }, [on, peak, scale]);

  return useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
}

/**
 * A progress fill that travels instead of jumping.
 *
 * Every progress bar in the app is a `width: '<n>%'` View, so a project going
 * from 40% to 60% is a hard cut and a focus timer redraws its own length once a
 * second. A timing rather than a spring by default: a spring overshoots, and a
 * bar that overshoots its track has visibly lied about the number.
 *
 * `fraction` is clamped to 0–1; a non-finite one (an empty project, `0/0`)
 * reads as empty rather than as a crash. Pass a module-level `config` if you
 * override the default — an object literal is a new identity every render and
 * would retarget the fill on each one.
 */
export function useProgressWidth(fraction: number, config: WithTimingConfig = FADE) {
  const target = clamp01(fraction);
  const filled = useSharedValue(target);

  useEffect(() => {
    filled.value = withTiming(target, config);
  }, [target, config, filled]);

  return useAnimatedStyle(() => ({ width: `${filled.value * 100}%` as `${number}%` }));
}

function clamp01(value: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * The staggered arrival from `app/index.tsx`, as a hook.
 *
 * Returns a function to hand an `entering` prop, or `undefined` for every index
 * when the OS has asked for reduced motion — skipping the animation entirely is
 * the accommodation, a shorter one is not.
 *
 * **Outside a `Modal` only.** This is the one thing in this file that returns a
 * layout-animation builder, and those need a layout pass a `Modal`'s separate
 * native window does not reliably give them. Inside a sheet, mount `SheetCard`
 * or `useMountRise` on the container instead. It also needs a parent that has
 * already been laid out — see `Toast`, where returning `null` for an empty
 * container made every toast in the app invisible.
 */
export function useStaggeredEntry(options: { duration?: number; from?: 'none' | 'below' } = {}) {
  const { duration = 320, from = 'none' } = options;
  const reduced = useReducedMotion();

  return useCallback(
    (index: number): EntryOrExitLayoutType | undefined => {
      if (reduced) return undefined;
      const builder = from === 'below' ? FadeInDown : FadeIn;
      return builder.duration(duration).delay(stagger(index));
    },
    [reduced, duration, from],
  );
}
