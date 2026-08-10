/**
 * The small shared pieces both project screens draw with.
 *
 * They are here rather than in `@/ui/components` because each one encodes a
 * *projects* decision (what "behind schedule" looks like, how a placeholder row
 * is shaped) rather than a general primitive.
 */
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { now } from '@/core/clock';
import { percent } from '@/core/format';
import { currentZone, formatDayHeading, formatRelative } from '@/core/time';
import { Button, Card, Chip, Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';

import { deadlineOf } from './format';

/* ----------------------------------------------------------- ProgressBar -- */

export function ProgressBar({
  done,
  total,
  tone,
  height = 4,
}: {
  done: number;
  total: number;
  tone?: string;
  height?: number;
}) {
  const { colors, radius } = useTheme();
  const filled = percent(done, total);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={`${done} of ${total} done`}
      accessibilityValue={{ min: 0, max: 100, now: filled }}
      style={{
        height,
        borderRadius: radius.pill,
        backgroundColor: colors.surfaceSunken,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          width: `${filled}%`,
          height: '100%',
          backgroundColor: tone ?? (filled === 100 ? colors.success : colors.accent),
        }}
      />
    </View>
  );
}

/* --------------------------------------------------------------- DueChip -- */

/** A date the user has to act on: relative once it is more than a day away. */
export function DueChip({ dueDate, muted }: { dueDate: number; muted?: boolean }) {
  const { colors } = useTheme();
  // One reading of the clock for both halves: two calls either side of midnight
  // would label a chip "Today" and colour it as overdue.
  const at = now();
  const deadline = deadlineOf(dueDate, at);
  const label =
    Math.abs(deadline.days) <= 1
      ? formatDayHeading(dueDate, currentZone(), at)
      : formatRelative(dueDate, at);
  const color = muted
    ? colors.textTertiary
    : deadline.tone === 'danger'
      ? colors.danger
      : deadline.tone === 'warning'
        ? colors.warning
        : colors.textTertiary;
  return <Chip label={label} color={color} size="sm" />;
}

/* ---------------------------------------------------------- SkeletonRows -- */

/** Cached data is never blocked by a spinner; only a cold list gets these. */
export function SkeletonRows({ count = 4, height = 58 }: { count?: number; height?: number }) {
  const { colors, radius, spacing } = useTheme();
  return (
    // `accessible` collapses the placeholders into one node: without it the
    // label is never announced and VoiceOver stops on each empty block.
    <View accessible accessibilityLabel="Loading" style={{ gap: spacing.sm }}>
      {Array.from({ length: count }, (_, i) => (
        <View
          key={i}
          style={{
            height,
            borderRadius: radius.md,
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderWidth: StyleSheet.hairlineWidth,
            // Later rows fade out: it reads as "more below" rather than as a
            // list that is genuinely this long.
            opacity: 1 - i * 0.18,
          }}
        />
      ))}
    </View>
  );
}

/* --------------------------------------------------------------- ErrorRow */

export function ErrorRow({
  message,
  onRetry,
  busy,
}: {
  message: string;
  onRetry: () => void;
  busy?: boolean;
}) {
  const { colors, spacing } = useTheme();
  return (
    <Card accent={colors.danger}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <Ionicons name="alert-circle-outline" size={20} color={colors.danger} />
        <Txt variant="caption" tone="secondary" style={{ flex: 1 }}>
          {message}
        </Txt>
        <Button label="Retry" size="sm" icon="refresh" onPress={onRetry} loading={busy} />
      </View>
    </Card>
  );
}
