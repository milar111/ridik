import { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { now } from '@/core/clock';
import { countLabel } from '@/core/format';
import {
  epochToLocal,
  formatDayHeading,
  formatDuration,
  formatTime,
  localDateOf,
  localToEpoch,
  luxonWeekdayToSchema,
  type LocalDate,
} from '@/core/time';
import type { CalendarEvent } from '@/db/schema';
import { useCalendarDay, useCurriculumDay } from '@/hooks';
import { Button, Card, EmptyState, MIC_CLEARANCE, Txt } from '@/ui/components';
import { REFLOW_MS } from '@/ui/motion';
import { useStaggeredEntry } from '@/ui/motionHooks';
import { useTheme } from '@/ui/ThemeProvider';
import { colorForTag, type Colors } from '@/ui/theme';

import { buildAgenda, classesOnDate, durationMinutes, type AgendaItem } from './agenda';

/** Wide enough for "all day" at micro size; anything wider wastes the row. */
const GUTTER_WIDTH = 52;

export type OpenEvent = { event: CalendarEvent; buffer: CalendarEvent | null };

export type AgendaListProps = {
  date: LocalDate;
  zone: string;
  onOpen: (target: OpenEvent) => void;
};

/**
 * The selected day as one schedule: time gutter on the left, cards on the
 * right, timetable classes folded in among the one-off events.
 */
export function AgendaList({ date, zone, onOpen }: AgendaListProps) {
  const { colors, spacing } = useTheme();
  const arrive = useStaggeredEntry({ from: 'below' });

  const dayOfWeek = useMemo(
    () => luxonWeekdayToSchema(epochToLocal(localToEpoch(date, zone), zone).weekday),
    [date, zone],
  );

  const events = useCalendarDay(date, { zone });
  const classes = useCurriculumDay(dayOfWeek);

  const items = useMemo(
    () => buildAgenda(events.data ?? [], classesOnDate(classes.data ?? [], date, zone)),
    [classes.data, date, events.data, zone],
  );

  const nowMs = now();
  const heading = formatDayHeading(localToEpoch(date, zone), zone, nowMs);
  const showNowLine = date === localDateOf(nowMs, zone);
  // The first future item is where the "now" rule goes; -1 means it is past.
  const nowIndex = showNowLine ? items.findIndex((item) => item.endsAt > nowMs) : -1;

  const eventCount = items.filter((item) => item.type === 'event').length;
  const classCount = items.length - eventCount;

  return (
    <ScrollView
      testID="agenda-list"
      // Bounded height, or the list grows past the screen instead of scrolling.
      style={styles.scroll}
      contentContainerStyle={{
        paddingHorizontal: spacing.lg,
        paddingBottom: MIC_CLEARANCE,
        gap: spacing.sm,
      }}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.heading}>
        <Txt variant="heading">{heading}</Txt>
        <Txt variant="caption" tone="tertiary">
          {items.length === 0
            ? 'Clear'
            : [
                eventCount > 0 ? countLabel(eventCount, 'event') : null,
                classCount > 0 ? countLabel(classCount, 'class', 'classes') : null,
              ]
                .filter(Boolean)
                .join(' · ')}
        </Txt>
      </View>

      {events.isError ? (
        <Card>
          <View style={styles.errorRow}>
            <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
            <Txt variant="caption" tone="secondary" style={{ flex: 1 }}>
              This day would not load.
            </Txt>
            <Button label="Retry" size="sm" onPress={() => void events.refetch()} />
          </View>
        </Card>
      ) : null}

      {events.isLoading && items.length === 0 ? <AgendaSkeleton /> : null}

      {!events.isLoading && !events.isError && items.length === 0 ? (
        <EmptyState
          icon="calendar-outline"
          title="Nothing on this day"
          hint="Try: “dentist Tuesday at 3 at the clinic” — I add the travel time for you."
        />
      ) : null}

      {items.map((item, index) => (
        // Keyed on the item, so changing day remounts the column and it arrives
        // again — the day you swiped to is new content, not the same list
        // re-rendered. `layout` is for the NOW line, which is drawn inside the
        // row it sits above and walks down the day as the clock advances.
        <Animated.View
          key={item.key}
          entering={arrive(index)}
          layout={LinearTransition.duration(REFLOW_MS)}
        >
          {index === nowIndex ? <NowLine at={nowMs} zone={zone} /> : null}
          {item.type === 'event' ? (
            <EventRow item={item} zone={zone} nowMs={nowMs} onOpen={onOpen} />
          ) : (
            <ClassRow item={item} zone={zone} nowMs={nowMs} />
          )}
        </Animated.View>
      ))}

      {/* A day whose every item is behind us still deserves the marker. */}
      {showNowLine && nowIndex === -1 && items.length > 0 ? <NowLine at={nowMs} zone={zone} /> : null}
    </ScrollView>
  );
}

/* -------------------------------------------------------------------- rows */

function EventRow({
  item,
  zone,
  nowMs,
  onOpen,
}: {
  item: Extract<AgendaItem, { type: 'event' }>;
  zone: string;
  nowMs: number;
  onOpen: (target: OpenEvent) => void;
}) {
  const { colors, spacing } = useTheme();
  const { event, buffer } = item;
  const past = event.endsAt <= nowMs;
  const rule = ruleColor(event, colors);

  return (
    <View>
      {buffer ? (
        <View style={styles.row}>
          <Gutter top={formatTime(buffer.startsAt, zone)} muted />
          <View style={styles.column}>
            <Card
              padded={false}
              accent={rule}
              onPress={() => onOpen({ event: buffer, buffer: null })}
              // Square where it meets its event: the block belongs to the
              // meeting below it, not to the gap above.
              style={[styles.attachedTop, { backgroundColor: colors.surfaceSunken }]}
            >
              <View style={[styles.bufferInner, { paddingHorizontal: spacing.md }]}>
                <Ionicons name="walk-outline" size={13} color={colors.textTertiary} />
                <Txt variant="caption" tone="tertiary" numberOfLines={1} style={{ flex: 1 }}>
                  {buffer.title}
                </Txt>
                <Txt variant="micro" tone="tertiary">
                  {formatDuration(durationMinutes(buffer.startsAt, buffer.endsAt))}
                </Txt>
              </View>
            </Card>
          </View>
        </View>
      ) : null}

      <View style={styles.row}>
        <Gutter
          top={event.allDay ? 'all day' : formatTime(event.startsAt, zone)}
          bottom={event.allDay ? undefined : formatDuration(durationMinutes(event.startsAt, event.endsAt))}
          muted={past}
        />
        <View style={styles.column}>
          <Card
            accent={rule}
            onPress={() => onOpen({ event, buffer })}
            style={buffer ? styles.attachedBottom : undefined}
          >
            <View style={styles.cardInner}>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt variant="bodyStrong" tone={past ? 'secondary' : 'primary'} numberOfLines={2}>
                  {event.title}
                </Txt>
                {event.location ? (
                  <View style={styles.metaRow}>
                    <Ionicons name="location-outline" size={12} color={colors.textTertiary} />
                    <Txt variant="caption" tone="tertiary" numberOfLines={1} style={{ flex: 1 }}>
                      {event.location}
                    </Txt>
                  </View>
                ) : null}
              </View>
              <SyncDot status={event.syncStatus} />
            </View>
          </Card>
        </View>
      </View>
    </View>
  );
}

function ClassRow({
  item,
  zone,
  nowMs,
}: {
  item: Extract<AgendaItem, { type: 'class' }>;
  zone: string;
  nowMs: number;
}) {
  const { colors } = useTheme();
  const { entry } = item.slot;
  const past = item.endsAt <= nowMs;
  const tint = entry.color ?? colorForTag(entry.subjectName);
  const meta = [entry.location, entry.teacher].filter(Boolean).join(' · ');

  return (
    <View style={styles.row}>
      <Gutter
        top={formatTime(item.startsAt, zone)}
        bottom={formatDuration(durationMinutes(item.startsAt, item.endsAt))}
        muted={past}
      />
      {/* Not pressable: the timetable is edited on its own screen, and a card
          that opens nothing is worse than one that is plainly static. */}
      <View style={styles.column}>
        <Card accent={tint}>
          <View style={styles.cardInner}>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt variant="bodyStrong" tone={past ? 'secondary' : 'primary'} numberOfLines={2}>
                {entry.subjectName}
              </Txt>
              {meta ? (
                <Txt variant="caption" tone="tertiary" numberOfLines={1}>
                  {meta}
                </Txt>
              ) : null}
            </View>
            <Ionicons
              name="repeat"
              size={14}
              color={colors.textTertiary}
              accessibilityLabel="Repeats weekly"
            />
          </View>
        </Card>
      </View>
    </View>
  );
}

function Gutter({ top, bottom, muted }: { top: string; bottom?: string; muted?: boolean }) {
  return (
    <View style={styles.gutter}>
      <Txt variant="mono" tone={muted ? 'tertiary' : 'secondary'} style={styles.gutterTime}>
        {top}
      </Txt>
      {bottom ? (
        <Txt variant="micro" tone="tertiary" style={styles.gutterTime}>
          {bottom}
        </Txt>
      ) : null}
    </View>
  );
}

function NowLine({ at, zone }: { at: number; zone: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.row, styles.nowRow]} accessibilityLabel="Now">
      <View style={styles.gutter}>
        <Txt variant="micro" style={{ color: colors.accent, textAlign: 'right' }}>
          {formatTime(at, zone)}
        </Txt>
      </View>
      <View style={styles.nowTrack}>
        <View style={[styles.nowDot, { backgroundColor: colors.accent }]} />
        <View style={[styles.nowRule, { backgroundColor: colors.accent }]} />
      </View>
    </View>
  );
}

function SyncDot({ status }: { status: CalendarEvent['syncStatus'] }) {
  const { colors } = useTheme();
  if (status === 'synced') return null;
  const map = {
    pending: { icon: 'cloud-upload-outline', color: colors.textTertiary, label: 'Waiting to sync' },
    failed: { icon: 'alert-circle-outline', color: colors.danger, label: 'Sync failed' },
    local_only: { icon: 'phone-portrait-outline', color: colors.textTertiary, label: 'On this device only' },
  } as const;
  const entry = map[status];
  return <Ionicons name={entry.icon} size={13} color={entry.color} accessibilityLabel={entry.label} />;
}

function AgendaSkeleton() {
  const { colors, radius, spacing } = useTheme();
  return (
    <View style={{ gap: spacing.sm }} accessibilityLabel="Loading day">
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.row}>
          <View style={[styles.gutter, { paddingTop: 4 }]}>
            <View style={[styles.bone, { width: 34, height: 10, backgroundColor: colors.surfaceRaised, borderRadius: radius.sm }]} />
          </View>
          <View
            style={{
              flex: 1,
              height: 52,
              backgroundColor: colors.surfaceRaised,
              borderRadius: radius.md,
              opacity: 1 - i * 0.25,
            }}
          />
        </View>
      ))}
    </View>
  );
}

/** Colour carries the event's kind; a plain event stays uncoloured on purpose. */
function ruleColor(event: CalendarEvent, colors: Colors): string | undefined {
  if (event.kind === 'exam') return colors.danger;
  if (event.kind === 'event') return undefined;
  return colorForTag(event.kind);
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  heading: { paddingTop: 4, paddingBottom: 2, gap: 1 },
  row: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  gutter: { width: GUTTER_WIDTH, alignItems: 'flex-end', paddingTop: 10, gap: 1 },
  gutterTime: { textAlign: 'right' },
  // Card's own Pressable wrapper does not stretch, so the row's flex lives here.
  column: { flex: 1 },
  attachedTop: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderBottomWidth: 0 },
  attachedBottom: { borderTopLeftRadius: 0, borderTopRightRadius: 0 },
  cardInner: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bufferInner: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nowRow: { paddingVertical: 6 },
  nowTrack: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingTop: 6 },
  nowDot: { width: 6, height: 6, borderRadius: 3 },
  nowRule: { flex: 1, height: StyleSheet.hairlineWidth },
  bone: { alignSelf: 'flex-end' },
});
