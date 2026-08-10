/**
 * The one thing worth knowing without asking: what is next, and when to leave.
 */
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { epochToLocal } from '@/core/time';
import { useTheme } from '@/ui/ThemeProvider';
import { Txt } from '@/ui/components/Text';
import type { NextUp } from './next';

const clock = (epoch: number, zone?: string): string => epochToLocal(epoch, zone).toFormat('HH:mm');

export function NextUpLine({ next, zone }: { next: NextUp | null; zone?: string }) {
  const { colors, spacing } = useTheme();
  const router = useRouter();

  if (!next) {
    return (
      <View style={{ gap: 2 }}>
        <Txt variant="micro" tone="tertiary">
          NEXT
        </Txt>
        <Txt variant="body" tone="tertiary">
          Nothing left today
        </Txt>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${next.item.title} at ${clock(next.item.startsAt, zone)}. Open today.`}
      onPress={() => router.push('/today')}
      style={({ pressed }) => [{ gap: 2, opacity: pressed ? 0.6 : 1 }]}
    >
      <Txt variant="micro" tone="tertiary">
        NEXT
      </Txt>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm }}>
        <Txt variant="mono" tone="accent">
          {clock(next.item.startsAt, zone)}
        </Txt>
        <Txt variant="bodyStrong" numberOfLines={1} style={{ flex: 1 }}>
          {next.item.title}
        </Txt>
      </View>
      {/* The buffer is the actionable half of this: the appointment is at two,
          but the thing you have to do something about is leaving at twenty to. */}
      {next.leaveAt !== null ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Ionicons name="walk-outline" size={14} color={colors.textTertiary} />
          <Txt variant="caption" tone="secondary">
            leave at {clock(next.leaveAt, zone)}
          </Txt>
        </View>
      ) : next.item.location ? (
        <Txt variant="caption" tone="secondary" numberOfLines={1}>
          {next.item.location}
        </Txt>
      ) : null}
    </Pressable>
  );
}
