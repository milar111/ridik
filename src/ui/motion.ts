/**
 * One motion vocabulary, so the whole app moves like a single object.
 *
 * Scattered animation is what makes an interface feel assembled rather than
 * designed, and this app has so little on screen that any inconsistency is
 * obvious. Everything here comes from three springs and two durations; a screen
 * that needs a fourth should probably be using one of these differently.
 *
 * ## The three profiles, and what they are called here
 *
 * | Asked for         | Exported as    | What it is                                  |
 * | ----------------- | -------------- | ------------------------------------------- |
 * | snappy            | `SPRING_TAP`   | answers a finger; fast, no visible bounce   |
 * | playful / bouncy  | `SPRING_ENTER` | arrives with give; the overshoot is the joy |
 * | heavy             | `SPRING_HEAVY` | large surfaces; slow, settles once          |
 *
 * `SPRING_TAP` and `SPRING_ENTER` already *were* the first two — they are not
 * renamed, because every existing call site is correct under the new reading
 * and a rename would have been fifty diffs that changed nothing. `SPRINGS`
 * exposes the requested vocabulary as an alias table for anyone who thinks in
 * those words; it holds references, not copies, so the two cannot drift.
 *
 * Only `SPRING_HEAVY` is genuinely new: nothing in the app moved a *large*
 * surface with weight, so a sheet rising borrowed the entrance spring and a
 * chart bar had no spring at all.
 *
 * ## Reduced motion
 *
 * Every spring and every duration here carries `reduceMotion:
 * ReduceMotion.System`, so a value animated with one of them resolves to its
 * end state — not to a quicker animation — for anyone who asked the OS to stop.
 * That covers a value that is *going* somewhere. It does not cover a loop, an
 * entrance builder or anything that should not run at all: for those, branch on
 * `useReducedMotion()` and use `MOTION_OFF` (or return `undefined` for an
 * `entering` prop, as `app/index.tsx` does). Vestibular triggers do not care
 * how quick the movement was.
 *
 * Tokens only. The hooks built on top of these live in `./motionHooks` — a hook
 * has a lifecycle and an ordering contract where a token has neither, and this
 * file stays free of React so it reads as the palette it is.
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

/**
 * Large surfaces and long distances: a sheet, a page, a bar redrawing itself.
 *
 * Heavier than `SPRING_ENTER` in the two ways that read as mass — more inertia
 * and a softer pull — and damped hard enough that it settles once rather than
 * wobbling. A whole card bouncing looks cheap at the size a card is; the same
 * overshoot on a 28pt thumb is what makes the thumb feel alive.
 */
export const SPRING_HEAVY = {
  damping: 22,
  stiffness: 90,
  mass: 1.4,
  reduceMotion: ReduceMotion.System,
} as const;

/**
 * The three profiles under the names the design conversation uses.
 *
 * References, not copies — `SPRINGS.snappy === SPRING_TAP`. Prefer the direct
 * export at a call site; this is for code that has to *pick* a profile.
 */
export const SPRINGS = {
  snappy: SPRING_TAP,
  playful: SPRING_ENTER,
  heavy: SPRING_HEAVY,
} as const;

/** Which of the three a caller wants, when it has to be named at runtime. */
export type SpringProfile = keyof typeof SPRINGS;

/** A state change with no physicality to it — a colour, an opacity. */
export const FADE = {
  duration: 220,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;

/**
 * The same change, leaving.
 *
 * Something on its way out has already stopped being interesting, and matching
 * the entrance makes a dismissal feel reluctant. Faster, and eased *in* so it
 * commits immediately rather than lingering at full opacity.
 */
export const FADE_OUT = {
  duration: 140,
  easing: Easing.in(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;

/**
 * A held frame: the same API surface as `FADE`, with the movement taken out.
 *
 * For the case `reduceMotion` cannot reach — a loop, or an animation a caller
 * has decided should not play at all — so the branch stays one config swap
 * rather than two code paths that fall out of step. It is already instant, so
 * the `reduceMotion` flag on it changes nothing; it is there for uniformity.
 */
export const MOTION_OFF = {
  duration: 0,
  reduceMotion: ReduceMotion.System,
} as const;

/** Ambient movement: long enough that it reads as breathing, not blinking. */
export const BREATH_MS = 5200;

/** Stagger between siblings entering. Four steps is the most that reads. */
export const STAGGER_MS = 70;

/**
 * Where the stagger stops.
 *
 * Past four steps the last sibling is waiting on an animation the eye stopped
 * following, which on a long list means rows arriving after the finger has
 * already started scrolling. Everything from here on shares one delay.
 */
export const STAGGER_MAX = 4;

/**
 * A row changing *place* rather than appearing — `LinearTransition.duration()`.
 *
 * Matches `FADE`, so a list that reflows while something in it fades finishes
 * both at the same moment instead of in two beats.
 */
export const REFLOW_MS = FADE.duration;

/** Delay for the `index`-th sibling of a staggered entrance, capped. */
export const stagger = (index: number) => Math.min(Math.max(index, 0), STAGGER_MAX) * STAGGER_MS;

export const enter = <T extends number>(to: T) => withSpring(to, SPRING_ENTER);
export const tap = <T extends number>(to: T) => withSpring(to, SPRING_TAP);
export const heavy = <T extends number>(to: T) => withSpring(to, SPRING_HEAVY);
export const fade = <T extends number>(to: T) => withTiming(to, FADE);
/** Land on the value now, through the animation machinery. */
export const still = <T extends number>(to: T) => withTiming(to, MOTION_OFF);
