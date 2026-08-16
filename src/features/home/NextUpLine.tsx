/**
 * The one thing worth knowing without asking: what is next, and when to leave.
 *
 * Set as a readout rather than a sentence. The time is the largest type on the
 * screen after the mic itself, in the mono face, because it is the single
 * number you look up here — and a wide tabular numeral can be read at arm's
 * length on the way out of a door, which is exactly when it is needed.
 */
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { epochToLocal } from '@/core/time';
import { useTheme } from '@/ui/ThemeProvider';
import { Txt } from '@/ui/components/Text';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import type { NextUp } from './next';

const clock = (epoch: number, zone?: string): string => epochToLocal(epoch, zone).toFormat('HH:mm');

export function NextUpLine({ next, zone }: { next: NextUp | null; zone?: string }) {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  // The same numbers the hand-rolled version used — 0.985 of the size, 0.65 of
  // the opacity — now off the shared hook, so this is interruptible and the
  // spring is the one every other press in the app uses. Called above the
  // `!next` return: the line comes and goes with the day.
  const press = usePressScale({ scale: 0.985, opacity: 0.65 });

  if (!next) {
    return (
      <View style={{ gap: spacing.xs }}>
        <Txt variant="eyebrow" tone="tertiary">
          NEXT
        </Txt>
        <Txt variant="title" tone="tertiary">
          Nothing left today
        </Txt>
      </View>
    );
  }

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={`${next.item.title} at ${clock(next.item.startsAt, zone)}. Open today.`}
      {...press.handlers}
      onPress={() => router.push('/today')}
      style={[{ gap: spacing.xs }, press.style]}
    >
        <Txt variant="eyebrow" tone="tertiary">
        NEXT
      </Txt>
      <Txt variant="readout">{clock(next.item.startsAt, zone)}</Txt>
      <Txt variant="heading" numberOfLines={1}>
        {next.item.title}
      </Txt>
      {/* The buffer is the actionable half of this: the appointment is at
          three, but the thing you have to do something about is leaving at
          twenty to. */}
      {next.leaveAt !== null ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <Ionicons name="walk" size={14} color={colors.accent} />
          <Txt variant="mono" tone="accent">
            leave {clock(next.leaveAt, zone)}
          </Txt>
        </View>
      ) : next.item.location ? (
        <Txt variant="caption" tone="secondary" numberOfLines={1}>
          {next.item.location}
        </Txt>
      ) : null}
    </AnimatedPressable>
  );
}
