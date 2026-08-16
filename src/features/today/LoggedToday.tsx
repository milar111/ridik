import { View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { formatDuration, formatTime } from '@/core/time';
import { countLabel } from '@/core/format';
import type { ActivityEntry } from '@/db/schema';
import { Card, Divider, Txt } from '@/ui/components';
import { REFLOW_MS } from '@/ui/motion';
import { useStaggeredEntry } from '@/ui/motionHooks';
import { useTheme } from '@/ui/ThemeProvider';

/**
 * What you already got done today.
 *
 * The rest of Today is forward-looking; this is the only place the day's own
 * record shows up, and seeing "spent two hours debugging the I2C sensors" land
 * seconds after saying it is what makes the activity log feel worth keeping.
 */
export function LoggedToday({
  entries,
  zone,
  limit = 4,
}: {
  entries: readonly ActivityEntry[];
  zone: string;
  limit?: number;
}) {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const arrive = useStaggeredEntry({ from: 'below' });
  if (entries.length === 0) return null;

  // Newest first: the thing just said should be at the top.
  const ordered = [...entries].sort((a, b) => b.loggedAt - a.loggedAt);
  const shown = ordered.slice(0, limit);
  const minutes = ordered.reduce((total, entry) => total + (entry.durationMinutes ?? 0), 0);

  return (
    <Card padded={false} onPress={() => router.push('/activity')}>
      {shown.map((entry, index) => (
        // The thing just said arrives at the top and pushes the rest down. The
        // entrance is what marks it as new; `layout` is what stops the three
        // rows under it teleporting a row-height while it does.
        <Animated.View
          key={entry.id}
          entering={arrive(index)}
          layout={LinearTransition.duration(REFLOW_MS)}
        >
          {index > 0 ? <Divider inset={spacing.md} /> : null}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: spacing.sm,
              paddingVertical: 9,
              paddingHorizontal: spacing.md,
            }}
          >
            <Ionicons
              name="checkmark-circle-outline"
              size={15}
              color={colors.success}
              style={{ marginTop: 2 }}
            />
            <Txt variant="caption" style={{ flex: 1 }} numberOfLines={2}>
              {entry.description}
            </Txt>
            <Txt variant="micro" tone="tertiary">
              {entry.durationMinutes
                ? formatDuration(entry.durationMinutes)
                : formatTime(entry.loggedAt, zone)}
            </Txt>
          </View>
        </Animated.View>
      ))}
      <Divider inset={spacing.md} />
      <View style={{ paddingVertical: 7, paddingHorizontal: spacing.md }}>
        <Txt variant="micro" tone="tertiary">
          {countLabel(ordered.length, 'entry', 'entries')}
          {minutes > 0 ? ` · ${formatDuration(minutes)} tracked` : ''}
          {ordered.length > shown.length ? ` · ${ordered.length - shown.length} more` : ''}
        </Txt>
      </View>
    </Card>
  );
}
