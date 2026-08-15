/**
 * One Reanimated stand-in for the whole `ui` project.
 *
 * Reanimated 4 boots its worklets runtime the moment it is imported, and there
 * is no native side here — so every suite that reaches the component barrel had
 * to mock it. Seven suites had grown seven slightly different hand-rolled
 * versions, each exporting only what that tree happened to touch, which meant a
 * shared component could not start using a hook without breaking suites that
 * have nothing to do with it. `Toggle` and `Spinner` are in `Button` and in
 * every settings row, so that had become the common case.
 *
 * Wired in through the `ui` project's `moduleNameMapper` rather than a
 * `jest.mock` per file. Animations resolve to their end value immediately,
 * which is what a snapshot of a settled interface should show.
 */
import * as React from 'react';
import { View } from 'react-native';

type Anything = Record<string, unknown>;

/** Entering/exiting/layout builders are chainable and inert. */
const builder = new Proxy(function noop() {} as unknown as Anything, {
  get: (_target, prop) => (prop === 'name' || prop === 'displayName' ? 'MockAnimation' : () => builder),
  apply: () => builder,
});

/**
 * `Animated.View` drops the declarative-animation props: they are builder
 * objects, and passing one to a host `View` makes React warn about an unknown
 * prop on every render.
 */
function stripAnimationProps({ entering, exiting, layout, ...rest }: Anything) {
  return rest;
}

const AnimatedView = (props: Anything) => React.createElement(View, stripAnimationProps(props));
AnimatedView.displayName = 'Animated.View';

const createAnimatedComponent = (component: unknown) => {
  const Wrapped = (props: Anything) =>
    React.createElement(component as React.ComponentType<Anything>, stripAnimationProps(props));
  Wrapped.displayName = 'Animated.Component';
  return Wrapped;
};

/** A shared value that is a plain box: writes land, reads are synchronous. */
function useSharedValue<T>(initial: T) {
  const ref = React.useRef({ value: initial });
  return ref.current;
}

const identity = <T,>(to: T) => to;
const easing = () => (t: number) => t;

module.exports = {
  __esModule: true,
  default: {
    View: AnimatedView,
    Text: AnimatedView,
    ScrollView: AnimatedView,
    Image: AnimatedView,
    createAnimatedComponent,
  },

  createAnimatedComponent,

  useSharedValue,
  useAnimatedStyle: (factory: () => Anything) => factory(),
  useDerivedValue: <T,>(factory: () => T) => ({ value: factory() }),
  useAnimatedRef: () => ({ current: null }),
  useAnimatedReaction: () => {},
  // The suites render the settled interface, not the reduced-motion variant.
  useReducedMotion: () => false,

  withTiming: identity,
  withSpring: identity,
  withDelay: <T,>(_ms: number, to: T) => to,
  withRepeat: <T,>(to: T) => to,
  withSequence: (...steps: unknown[]) => steps[steps.length - 1],
  withDecay: identity,
  cancelAnimation: () => {},

  runOnJS:
    <A extends unknown[]>(fn: (...args: A) => unknown) =>
    (...args: A) =>
      fn(...args),
  runOnUI:
    <A extends unknown[]>(fn: (...args: A) => unknown) =>
    (...args: A) =>
      fn(...args),

  interpolate: (value: number) => value,
  interpolateColor: (_value: number, _input: number[], output: string[]) => output[0],
  Extrapolation: { CLAMP: 'clamp', EXTEND: 'extend', IDENTITY: 'identity' },
  ReduceMotion: { System: 'system', Always: 'always', Never: 'never' },

  Easing: {
    linear: easing(),
    ease: easing(),
    quad: easing(),
    cubic: easing(),
    sin: easing(),
    exp: easing(),
    circle: easing(),
    bezier: () => easing(),
    in: easing,
    out: easing,
    inOut: easing,
  },

  FadeIn: builder,
  FadeInUp: builder,
  FadeInDown: builder,
  FadeOut: builder,
  FadeOutUp: builder,
  FadeOutDown: builder,
  SlideInDown: builder,
  SlideOutDown: builder,
  LinearTransition: builder,
};
