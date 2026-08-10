import { Fragment } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { formatTime } from '@/core/time';
import { useTheme } from '@/ui/ThemeProvider';
import { colorForTag } from '@/ui/theme';
import { Txt } from '@/ui/components';

import type { Agenda, AgendaItem } from './agenda';

/**
 * The day as a single time-ordered column.
 *
 * Two deliberate departures from a plain list. Travel/prep blocks are thinner
 * and muted, so the twenty minutes the calendar engine inserted read as
 * scaffolding rather than as another appointment competing for attention. And a
 * rule marks where "now" falls between two rows, which is the one thing a
 * glance at an agenda is actually asking.
 */
export function AgendaList({ agenda, now, zone }: { agenda: Agenda; now: number; zone: string }) {
  return (
    <View>
      {agenda.allDay.map((item, index) => (
        <Row key={item.key} item={item} now={now} zone={zone} allDay divider={index > 0} />
      ))}

      {agenda.timed.map((item, index) => (
        <Fragment key={item.key}>
          {index === agenda.nowIndex ? <NowRule /> : null}
          <Row
            item={item}
            now={now}
            zone={zone}
            // The rule is already a line; a divider under it would double it.
            divider={(index > 0 || agenda.allDay.length > 0) && index !== agenda.nowIndex}
          />
        </Fragment>
      ))}

      {/* The whole day is behind us: the rule belongs after the last row. */}
      {agenda.timed.length > 0 && agenda.nowIndex >= agenda.timed.length ? <NowRule /> : null}

      {agenda.timed.length === 0 && agenda.allDay.length > 0 ? (
        <Txt variant="caption" tone="tertiary" style={styles.footnote}>
          Nothing else scheduled.
        </Txt>
      ) : null}
    </View>
  );
}

function NowRule() {
  const { colors } = useTheme();
  return (
    <View style={styles.now} accessibilityRole="text" accessibilityLabel="Now">
      <View style={[styles.nowDot, { backgroundColor: colors.accent }]} />
      <View style={[styles.nowLine, { backgroundColor: colors.accent }]} />
      <Txt variant="micro" style={{ color: colors.accent, letterSpacing: 0.8 }}>
        NOW
      </Txt>
    </View>
  );
}

function Row({
  item,
  now,
  zone,
  allDay,
  divider,
}: {
  item: AgendaItem;
  now: number;
  zone: string;
  allDay?: boolean;
  divider?: boolean;
}) {
  const router = useRouter();
  const { colors } = useTheme();

  const past = !allDay && item.endsAt <= now;
  const running = !allDay && item.startsAt <= now && item.endsAt > now;
  const isBuffer = item.kind === 'buffer';

  const title = isBuffer ? 'Travel / prep' : item.title;
  const detail = isBuffer
    ? (item.bufferFor ?? 'Leave in time')
    : [item.location, allDay ? null : formatTime(item.endsAt, zone)]
        .filter((part): part is string => Boolean(part))
        .join(' · ');

  const dot = item.kind === 'class' ? (item.color ?? colorForTag(item.title)) : null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        allDay ? `${title}, all day` : `${title} at ${formatTime(item.startsAt, zone)}`
      }
      accessibilityHint="Opens the calendar"
      onPress={() => router.push('/calendar')}
      // A buffer row is deliberately half-height, which would leave it a 32pt
      // target; the slop puts the tappable area back over 44 without making the
      // scaffolding look like an appointment.
      hitSlop={isBuffer ? { top: 6, bottom: 6 } : undefined}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: isBuffer ? 32 : 44,
          borderTopWidth: divider ? StyleSheet.hairlineWidth : 0,
          borderTopColor: colors.border,
          opacity: pressed ? 0.6 : past ? 0.42 : 1,
        },
      ]}
    >
      <View style={styles.timeCol}>
        <Txt
          variant={isBuffer ? 'micro' : 'mono'}
          tone={running ? 'accent' : isBuffer ? 'tertiary' : 'secondary'}
        >
          {allDay ? 'all day' : formatTime(item.startsAt, zone)}
        </Txt>
      </View>

      {dot ? <View style={[styles.dot, { backgroundColor: dot }]} /> : <View style={styles.dotGap} />}

      <View style={styles.body}>
        <Txt
          variant={isBuffer ? 'caption' : 'body'}
          tone={isBuffer ? 'tertiary' : 'primary'}
          weight={running ? '600' : undefined}
          numberOfLines={1}
        >
          {title}
        </Txt>
        {detail ? (
          <Txt variant="micro" tone="tertiary" numberOfLines={1}>
            {detail}
          </Txt>
        ) : null}
      </View>

      {isBuffer ? (
        <Ionicons name="walk-outline" size={13} color={colors.textTertiary} />
      ) : item.kind === 'class' ? (
        <Ionicons name="school-outline" size={13} color={colors.textTertiary} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  timeCol: { width: 46 },
  footnote: { paddingTop: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotGap: { width: 6 },
  body: { flex: 1, gap: 1 },
  now: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  nowDot: { width: 5, height: 5, borderRadius: 2.5 },
  nowLine: { flex: 1, height: StyleSheet.hairlineWidth },
});
