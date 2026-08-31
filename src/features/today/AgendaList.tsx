import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { formatTime } from '@/core/time';
import { useTheme } from '@/ui/ThemeProvider';
import { colorForTag } from '@/ui/theme';
import { AnimatedPressable, usePressScale , useStaggeredEntry } from '@/ui/motionHooks';
import { Txt } from '@/ui/components';
import { REFLOW_MS } from '@/ui/motion';

import { clashingKeys, type Agenda, type AgendaItem } from './agenda';

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
  // One arrival down the whole column: the all-day rows and the timed ones read
  // as a single list, so the timed ones carry on counting where all-day stopped
  // rather than restarting the stagger halfway down.
  const arrive = useStaggeredEntry({ from: 'below' });

  // Computed once for the column rather than per row: a row cannot know it
  // clashes without seeing its neighbours, and asking each one to look would
  // walk the day n times over.
  const clashes = useMemo(() => clashingKeys(agenda), [agenda]);

  return (
    <View>
      {agenda.allDay.map((item, index) => (
        <Animated.View
          key={item.key}
          entering={arrive(index)}
          layout={LinearTransition.duration(REFLOW_MS)}
        >
          <Row item={item} now={now} zone={zone} allDay divider={index > 0} />
        </Animated.View>
      ))}

      {agenda.timed.map((item, index) => (
        <Animated.View
          key={item.key}
          entering={arrive(agenda.allDay.length + index)}
          // The rule is drawn inside the row it sits above, so the row owns the
          // height the rule adds. `useNow` walks it down the list as the clock
          // advances, and `layout` is what makes everything below step down
          // with it instead of jumping a rule-height in one frame.
          layout={LinearTransition.duration(REFLOW_MS)}
        >
          {index === agenda.nowIndex ? <NowRule /> : null}
          <Row
            item={item}
            now={now}
            zone={zone}
            clash={clashes.has(item.key)}
            // The rule is already a line; a divider under it would double it.
            divider={(index > 0 || agenda.allDay.length > 0) && index !== agenda.nowIndex}
          />
        </Animated.View>
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
      <Txt variant="eyebrow" style={{ color: colors.accent }}>
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
  clash,
}: {
  item: AgendaItem;
  now: number;
  zone: string;
  allDay?: boolean;
  divider?: boolean;
  /** This row overlaps another appointment. See `clashingKeys`. */
  clash?: boolean;
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

  // Scale only, no `opacity` option: the row already owns its opacity to fade
  // what is behind us, and a press that wrote `opacity` would have to know
  // about that and would clobber it on release.
  const press = usePressScale({ scale: 0.98 });

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={[
        allDay ? `${title}, all day` : `${title} at ${formatTime(item.startsAt, zone)}`,
        // Otherwise the one row that needs reading most is the one whose warning
        // is a coloured pill and nothing else.
        clash ? 'clashes with another appointment' : null,
      ]
        .filter(Boolean)
        .join(', ')}
      accessibilityHint="Opens the calendar"
      onPress={() => router.push('/calendar')}
      // A buffer row is deliberately half-height, which would leave it a 32pt
      // target; the slop puts the tappable area back over 44 without making the
      // scaffolding look like an appointment.
      hitSlop={isBuffer ? { top: 6, bottom: 6 } : undefined}
      {...press.handlers}
      style={[
        styles.row,
        {
          minHeight: isBuffer ? 32 : 44,
          borderTopWidth: divider ? StyleSheet.hairlineWidth : 0,
          borderTopColor: colors.border,
          opacity: past ? 0.42 : 1,
        },
        press.style,
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

      {clash ? (
        <View style={[styles.clash, { backgroundColor: colors.warningMuted }]}>
          <Txt variant="eyebrow" style={[styles.clashLabel, { color: colors.warning }]}>
            CLASH
          </Txt>
        </View>
      ) : null}

      {isBuffer ? (
        <Ionicons name="walk-outline" size={13} color={colors.textTertiary} />
      ) : item.kind === 'class' ? (
        <Ionicons name="school-outline" size={13} color={colors.textTertiary} />
      ) : null}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  timeCol: { width: 46 },
  footnote: { paddingTop: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotGap: { width: 6 },
  body: { flex: 1, gap: 1 },
  clash: { paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4 },
  // Tracked mono sized to its own content is measured short on Android and
  // loses its last character; an explicit width plus `textAlign` is the fix.
  clashLabel: { width: 42, textAlign: 'center' },
  now: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  nowDot: { width: 5, height: 5, borderRadius: 2.5 },
  nowLine: { flex: 1, height: StyleSheet.hairlineWidth },
});
