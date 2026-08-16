import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { useTheme } from '@/ui/ThemeProvider';
import { Section } from '@/ui/components';
import { usePulse } from '@/ui/motionHooks';

/**
 * The first cold read only.
 *
 * Today is the launch screen, so the very first frame after the splash has no
 * cache to draw on. Rows of the right shape and count tell the user what is
 * about to arrive; a spinner in the middle of an empty screen does not. Every
 * later load renders over the cached snapshot instead — see the screen's
 * `isPending && !data` gate.
 */
export function TodaySkeleton() {
  const { spacing } = useTheme();
  // `usePulse` is the same loop this file used to hand-roll, with the one thing
  // the hand-rolled version was missing: a repeat cannot be reduced away by a
  // config, so the hook branches on `useReducedMotion()` and holds the bars at
  // `from`. The period stays 780ms — this is a load, not the ambient breath.
  const pulse = usePulse({ from: 0.5, to: 1, ms: 780 });

  return (
    // A bare `View` is not `accessible`, so the label alone would announce
    // nothing: the whole block has to be one element for VoiceOver to read it.
    <View style={{ gap: spacing.lg }} accessible accessibilityLabel="Loading your day">
      <Bar pulse={pulse} height={74} radius={12} />
      <Section title="Agenda">
        <Rows pulse={pulse} count={4} />
      </Section>
      <Section title="Due today">
        <Rows pulse={pulse} count={3} />
      </Section>
    </View>
  );
}

type Pulse = SharedValue<number>;

function Rows({ pulse, count }: { pulse: Pulse; count: number }) {
  return (
    <View style={{ gap: 10 }}>
      {Array.from({ length: count }, (_, i) => (
        // Staggered widths so the block reads as a list of rows rather than a
        // grey rectangle with lines in it.
        <Bar key={i} pulse={pulse} height={22} radius={6} width={`${92 - i * 9}%`} />
      ))}
    </View>
  );
}

function Bar({
  pulse,
  height,
  radius,
  width = '100%',
}: {
  pulse: Pulse;
  height: number;
  radius: number;
  width?: number | `${number}%`;
}) {
  const { colors } = useTheme();
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return (
    <Animated.View
      style={[
        styles.bar,
        style,
        { height, width, borderRadius: radius, backgroundColor: colors.surfaceRaised },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  bar: { overflow: 'hidden' },
});
