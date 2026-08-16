/**
 * The motion vocabulary, and the hooks built on it.
 *
 * Two things here are worth a test rather than a review comment. The first is
 * that every spring carries `ReduceMotion.System` — it is one line, it is
 * invisible when missing, and the cost of missing it is a user who asked the OS
 * to stop animating being animated at. The second is the press scale, which is
 * about to be the most-called hook in the app.
 *
 * Runs under the `ui` project, so `react-native-reanimated` is the shared mock:
 * animations resolve to their end value, which is why the assertions look at a
 * *re-rendered* tree — the shared value has landed, and the next render reads
 * it. A `.test.ts` here would run under `logic` instead, in Node, where real
 * Reanimated cannot load.
 */
import { StyleSheet } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import Animated, { ReduceMotion } from 'react-native-reanimated';

import {
  FADE,
  FADE_OUT,
  MOTION_OFF,
  REFLOW_MS,
  SPRINGS,
  SPRING_ENTER,
  SPRING_HEAVY,
  SPRING_TAP,
  STAGGER_MAX,
  STAGGER_MS,
  stagger,
} from '../motion';
import {
  AnimatedPressable,
  useCheckPop,
  useMountRise,
  usePressScale,
  useProgressWidth,
  useStaggeredEntry,
} from '../motionHooks';

const flat = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style) as Record<string, unknown> & {
    transform?: { scale?: number; translateY?: number }[];
  };

describe('motion tokens', () => {
  it('carries ReduceMotion.System on every spring and every duration', () => {
    const configs = [SPRING_TAP, SPRING_ENTER, SPRING_HEAVY, FADE, FADE_OUT, MOTION_OFF];
    for (const config of configs) expect(config.reduceMotion).toBe(ReduceMotion.System);
  });

  it('names the three profiles without copying them', () => {
    expect(SPRINGS.snappy).toBe(SPRING_TAP);
    expect(SPRINGS.playful).toBe(SPRING_ENTER);
    expect(SPRINGS.heavy).toBe(SPRING_HEAVY);
  });

  it('is heaviest where it says it is', () => {
    // Mass up and stiffness down is what reads as weight; the ordering is the
    // whole point of having three profiles rather than one tuned twice.
    expect(SPRING_HEAVY.mass).toBeGreaterThan(SPRING_ENTER.mass);
    expect(SPRING_HEAVY.stiffness).toBeLessThan(SPRING_ENTER.stiffness);
    expect(SPRING_TAP.stiffness).toBeGreaterThan(SPRING_ENTER.stiffness);
  });

  it('caps the stagger so a long list does not arrive after the scroll', () => {
    expect(stagger(0)).toBe(0);
    expect(stagger(2)).toBe(2 * STAGGER_MS);
    expect(stagger(40)).toBe(STAGGER_MAX * STAGGER_MS);
    expect(REFLOW_MS).toBe(FADE.duration);
  });

  it('lands immediately when motion is off', () => {
    expect(MOTION_OFF.duration).toBe(0);
  });
});

function Pressy() {
  const press = usePressScale();
  return <AnimatedPressable testID="pressy" {...press.handlers} style={press.style} />;
}

function Dimmer() {
  const press = usePressScale({ scale: 0.98, opacity: 0.6 });
  return <AnimatedPressable testID="dimmer" {...press.handlers} style={press.style} />;
}

function Riser() {
  return <Animated.View testID="riser" style={useMountRise()} />;
}

function Bar({ value }: { value: number }) {
  return <Animated.View testID="bar" style={useProgressWidth(value)} />;
}

function Tick({ done }: { done: boolean }) {
  return <Animated.View testID="tick" style={useCheckPop(done)} />;
}

function Stack() {
  const arrive = useStaggeredEntry();
  return <Animated.View testID="stack" entering={arrive(1)} />;
}

describe('motion hooks', () => {
  it('sinks a pressed surface and springs it back', async () => {
    const { rerender } = await render(<Pressy />);
    expect(flat('pressy').transform?.[0]?.scale).toBe(1);

    await fireEvent(screen.getByTestId('pressy'), 'pressIn');
    await rerender(<Pressy />);
    expect(flat('pressy').transform?.[0]?.scale).toBeCloseTo(0.96);

    await fireEvent(screen.getByTestId('pressy'), 'pressOut');
    await rerender(<Pressy />);
    expect(flat('pressy').transform?.[0]?.scale).toBe(1);
  });

  it('leaves opacity alone unless a caller asked for it', async () => {
    await render(<Pressy />);
    expect(flat('pressy').opacity).toBeUndefined();

    const dimmer = await render(<Dimmer />);
    await fireEvent(screen.getByTestId('dimmer'), 'pressIn');
    await dimmer.rerender(<Dimmer />);
    expect(flat('dimmer').opacity).toBeCloseTo(0.6);
  });

  it('rises to its resting place on mount', async () => {
    const { rerender } = await render(<Riser />);
    await rerender(<Riser />);
    expect(flat('riser').opacity).toBe(1);
    expect(flat('riser').transform?.[0]?.translateY).toBe(0);
  });

  it('fills a progress bar and refuses to overrun it', async () => {
    const { rerender } = await render(<Bar value={0.5} />);
    expect(flat('bar').width).toBe('50%');

    // Twice: the effect lands the value after the render that scheduled it, so
    // the next render is the one that reads it. Under real Reanimated the style
    // is recomputed on the UI thread and no second render is involved.
    await rerender(<Bar value={4} />);
    await rerender(<Bar value={4} />);
    expect(flat('bar').width).toBe('100%');

    await rerender(<Bar value={Number.NaN} />);
    await rerender(<Bar value={Number.NaN} />);
    expect(flat('bar').width).toBe('0%');
  });

  it('settles a tick at its own size, mounted or popped', async () => {
    const { rerender } = await render(<Tick done={false} />);
    expect(flat('tick').transform?.[0]?.scale).toBe(1);

    await rerender(<Tick done />);
    await rerender(<Tick done />);
    expect(flat('tick').transform?.[0]?.scale).toBe(1);
  });

  it('hands out an entering animation for a staggered child', async () => {
    await render(<Stack />);
    expect(screen.getByTestId('stack')).toBeTruthy();
  });
});
