/**
 * The one thing worth knowing without asking: what is next, and when to leave.
 *
 * Set as a readout rather than a sentence. The time is the largest type on the
 * screen after the mic itself, in the mono face, because it is the single
 * number you look up here — and a wide tabular numeral can be read at arm's
 * length on the way out of a door, which is exactly when it is needed.
 */
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { epochToLocal } from '@/core/time';
import { useTheme } from '@/ui/ThemeProvider';
import { Txt } from '@/ui/components/Text';
import { tap } from '@/ui/motion';
import type { NextUp } from './next';

const clock = (epoch: number, zone?: string): string => epochToLocal(epoch, zone).toFormat('HH:mm');

export function NextUpLine({ next, zone }: { next: NextUp | null; zone?: string }) {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const press = useSharedValue(0);

  const style = useAnimatedStyle(() => ({
    opacity: 1 - press.value * 0.35,
    transform: [{ scale: 1 - press.value * 0.015 }],
  }));

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
    <Animated.View style={style}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${next.item.title} at ${clock(next.item.startsAt, zone)}. Open today.`}
        onPressIn={() => {
          press.value = tap(1);
        }}
        onPressOut={() => {
          press.value = tap(0);
        }}
        onPress={() => router.push('/today')}
        style={{ gap: spacing.xs }}
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
      </Pressable>
    </Animated.View>
  );
}
