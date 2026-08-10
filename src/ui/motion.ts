/**
 * One motion vocabulary, so the whole app moves like a single object.
 *
 * Scattered animation is what makes an interface feel assembled rather than
 * designed, and this app has so little on screen that any inconsistency is
 * obvious. Everything here comes from two springs and two durations; a screen
 * that needs a third should probably be using one of these differently.
 *
 * Reduced motion is not an afterthought — `MOTION_OFF` is exported so callers
 * can branch to a still frame rather than a faster animation. Vestibular
 * triggers do not care how quick the movement was.
 */
import { Easing, ReduceMotion, withSpring, withTiming } from 'react-native-reanimated';

/** Controls answering a finger: fast, barely overshooting, never bouncy. */
export const SPRING_TAP = {
  damping: 18,
  stiffness: 320,
  mass: 0.7,
  reduceMotion: ReduceMotion.System,
} as const;

/** Things arriving on screen: slower, with enough give to feel physical. */
export const SPRING_ENTER = {
  damping: 16,
  stiffness: 140,
  mass: 0.9,
  reduceMotion: ReduceMotion.System,
} as const;

/** A state change with no physicality to it — a colour, an opacity. */
export const FADE = {
  duration: 220,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;

/** Ambient movement: long enough that it reads as breathing, not blinking. */
export const BREATH_MS = 5200;

/** Stagger between siblings entering. Four steps is the most that reads. */
export const STAGGER_MS = 70;

export const enter = <T extends number>(to: T) => withSpring(to, SPRING_ENTER);
export const tap = <T extends number>(to: T) => withSpring(to, SPRING_TAP);
export const fade = <T extends number>(to: T) => withTiming(to, FADE);
