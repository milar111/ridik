import { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { now } from '@/core/clock';
import { countLabel } from '@/core/format';
import {
  clockColumnWidth,
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
import { Button, Card, Divider, EmptyState, MIC_CLEARANCE, Txt } from '@/ui/components';
import { REFLOW_MS } from '@/ui/motion';
import { useStaggeredEntry } from '@/ui/motionHooks';
import { useTheme } from '@/ui/ThemeProvider';
import { colorForTag, type Colors, type ColorScheme } from '@/ui/theme';

import {
  buildAgenda,
  classesOnDate,
  durationMinutes,
  joinsOf,
  type AgendaItem,
  type AgendaJoin,
} from './agenda';

/**
 * The time column. 44pt is what "14:00" measures in Martian at `mono`'s 13, and
 * nothing but a clock reading goes in it any more — "all day" used to, and an
 * all-day event has no time, which is the whole point of it. Those have their
 * own band above the day now.
 */
const GUTTER_WIDTH = 46;

/**
 * The gutter is sized from the *format*, not from a number.
 *
 * 46 is `21:00` in this face at this size, to the point. "12:00 AM" is 72.0,
 * and a column with room for one line and content for two does not truncate —
 * it wraps, so a 12-hour install read "3:00" over "PM" down the whole spine.
 * See `clockColumnWidth`.
 */
const gutterWidth = (): number => Math.max(GUTTER_WIDTH, clockColumnWidth());

/**
 * The spine: one continuous rule from the first item to the last, with a node
 * at each start.
 *
 * This is the redesign. A day was a stack of cards floating on the ground with
 * a time beside each, which is a *list of events* — it never showed the thing
 * you open a calendar to find out, which is the shape of the day. Two events
 * five hours apart looked exactly like two events back to back, and a class and
 * a meeting that collide looked exactly like two that do not. Both facts now
 * live on the rule between the cards: `joinsOf` computes them and `Join` draws
 * them.
 *
 * Not drawn to scale on purpose — see `AgendaJoin`. Five empty hours would cost
 * five empty hours of screen, and a named gap is the same fact in one line.
 */
const SPINE_WIDTH = 15;
const NODE = 7;
/**
 * Where the node sits from the top of its row — the optical centre of the
 * 13pt mono time beside it, so the clock reading and the dot are one line and
 * not two things that nearly agree.
 */
const SPINE_NODE_TOP = 15;

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

  // An all-day event has no place on a time spine — it has no time. Its own
  // band above the day is where it goes, and pulling it out is also what lets
  // the gutter be a clock column again.
  const allDay = useMemo(() => items.filter((item) => item.allDay), [items]);
  const timed = useMemo(() => items.filter((item) => !item.allDay), [items]);
  const joins = useMemo(() => joinsOf(timed), [timed]);

  const nowMs = now();
  const heading = formatDayHeading(localToEpoch(date, zone), zone, nowMs);
  const showNowLine = date === localDateOf(nowMs, zone);
  // The first future item is where the "now" rule goes; -1 means it is past.
  const nowIndex = showNowLine ? timed.findIndex((item) => item.endsAt > nowMs) : -1;

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
            <Button
              label="Retry"
              size="sm"
              // `Button` pins itself to `flex-start`, which on a row means the
              // top. Two lines of message and it hangs off the first one.
              style={styles.centreOnRow}
              onPress={() => void events.refetch()}
            />
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

      {allDay.length > 0 ? <AllDayBand items={allDay} onOpen={onOpen} /> : null}

      {timed.map((item, index) => (
        // Keyed on the item, so changing day remounts the column and it arrives
        // again — the day you swiped to is new content, not the same list
        // re-rendered. `layout` is for the NOW line, which is drawn inside the
        // row it sits above and walks down the day as the clock advances.
        <Animated.View
          key={item.key}
          entering={arrive(index)}
          layout={LinearTransition.duration(REFLOW_MS)}
        >
          {joins[index] ? <Join join={joins[index]} /> : null}
          {/* `head` when nothing is above it: the rail must not run up off the
              first row into empty ground, which is what it did at 09:53 on a
              day whose first item is at 14:00. */}
          {index === nowIndex ? (
            <NowLine at={nowMs} zone={zone} head={index === 0 && !joins[index]} />
          ) : null}
          {item.type === 'event' ? (
            <EventRow
              item={item}
              zone={zone}
              nowMs={nowMs}
              onOpen={onOpen}
              first={index === 0 && nowIndex !== 0}
              last={index === timed.length - 1 && !(showNowLine && nowIndex === -1)}
            />
          ) : (
            <ClassRow
              item={item}
              zone={zone}
              nowMs={nowMs}
              first={index === 0 && nowIndex !== 0}
              last={index === timed.length - 1 && !(showNowLine && nowIndex === -1)}
            />
          )}
        </Animated.View>
      ))}

      {/* A day whose every item is behind us still deserves the marker. */}
      {showNowLine && nowIndex === -1 && timed.length > 0 ? (
        <NowLine at={nowMs} zone={zone} tail />
      ) : null}
    </ScrollView>
  );
}

/* -------------------------------------------------------------------- rows */

/**
 * A day is one object, so it gets one rule down its left side.
 *
 * The node sits on the same centre line as its time, which is what ties the
 * clock column to the card. `top`/`bottom` say whether the rule continues past
 * this node — the day starts and ends on a node rather than trailing a line
 * into nothing.
 */
function Spine({
  top = true,
  bottom = true,
  tint,
  hollow,
}: {
  top?: boolean;
  bottom?: boolean;
  tint?: string;
  hollow?: boolean;
}) {
  const { colors } = useTheme();
  const line = tint ?? colors.border;
  return (
    <View style={styles.spine} pointerEvents="none">
      <View
        style={[
          styles.spineRail,
          { top: 0, height: SPINE_NODE_TOP, opacity: top ? 1 : 0, backgroundColor: line },
        ]}
      />
      <View
        style={[
          styles.spineRail,
          { top: SPINE_NODE_TOP + NODE, bottom: 0, opacity: bottom ? 1 : 0, backgroundColor: line },
        ]}
      />
      <View
        style={[
          styles.spineNode,
          {
            top: SPINE_NODE_TOP,
            borderColor: tint ?? colors.textTertiary,
            backgroundColor: hollow ? colors.bg : (tint ?? colors.textTertiary),
          },
        ]}
      />
    </View>
  );
}

/**
 * What sits between two cards: free time, or a collision.
 *
 * `butt` draws bare rule — two things back to back need no words, and a label
 * on every join would turn the spine into a second list.
 */
function Join({ join }: { join: AgendaJoin }) {
  const { colors } = useTheme();
  if (join.kind === 'butt') {
    return (
      <View style={styles.joinRow}>
        <View style={[styles.gutter, { width: gutterWidth() }]} />
        <View style={styles.spineFill}>
          <View style={[styles.spineRailStatic, { backgroundColor: colors.border }]} />
        </View>
        <View style={{ flex: 1 }} />
      </View>
    );
  }
  const clash = join.kind === 'overlap';
  const tint = clash ? colors.warning : colors.textTertiary;
  return (
    <View style={styles.joinRow} accessibilityLabel={joinLabel(join)}>
      <View style={[styles.gutter, { width: gutterWidth() }]} />
      <View style={styles.spineFill}>
        <View
          style={[
            styles.spineRailStatic,
            clash
              ? { backgroundColor: colors.warning, width: 3, borderRadius: 1.5 }
              : { backgroundColor: colors.border },
          ]}
        />
      </View>
      <View style={styles.joinLabel}>
        {clash ? <Ionicons name="alert-circle-outline" size={12} color={colors.warning} /> : null}
        <Txt variant="micro" style={{ color: tint }} numberOfLines={1}>
          {joinLabel(join)}
        </Txt>
      </View>
    </View>
  );
}

function joinLabel(join: AgendaJoin): string {
  if (join.kind === 'gap') return `${formatDuration(join.minutes)} free`;
  if (join.kind === 'overlap') return `Clashes by ${formatDuration(join.minutes)}`;
  return '';
}

/**
 * All-day events, above the day rather than in it.
 *
 * They have no time, which is the point of them, and the gutter used to carry
 * the words "all day" in a monospace clock column 46pt wide.
 */
function AllDayBand({
  items,
  onOpen,
}: {
  items: readonly AgendaItem[];
  onOpen: (target: OpenEvent) => void;
}) {
  const { colors, spacing } = useTheme();
  return (
    <View style={styles.row}>
      <View style={[styles.gutter, { width: gutterWidth() }]}>
        <Txt variant="micro" tone="tertiary" style={styles.gutterTime}>
          all day
        </Txt>
      </View>
      <View style={styles.spine} />
      <View style={styles.column}>
        <Card padded={false} style={{ backgroundColor: colors.surfaceSunken }}>
          {items.map((item, index) =>
            item.type !== 'event' ? null : (
              <Card
                key={item.key}
                padded={false}
                onPress={() => onOpen({ event: item.event, buffer: null })}
                style={{ borderWidth: 0, backgroundColor: 'transparent' }}
              >
                {index === 0 ? null : <Divider inset={spacing.md} />}
                <View style={[styles.allDayRow, { paddingHorizontal: spacing.md }]}>
                  <Ionicons name="sunny-outline" size={13} color={colors.textTertiary} />
                  <Txt variant="caption" numberOfLines={1} style={{ flex: 1 }}>
                    {item.event.title}
                  </Txt>
                  <SyncDot status={item.event.syncStatus} />
                </View>
              </Card>
            ),
          )}
        </Card>
      </View>
    </View>
  );
}

function EventRow({
  item,
  zone,
  nowMs,
  onOpen,
  first,
  last,
}: {
  item: Extract<AgendaItem, { type: 'event' }>;
  zone: string;
  nowMs: number;
  onOpen: (target: OpenEvent) => void;
  first: boolean;
  last: boolean;
}) {
  const { colors, spacing, scheme } = useTheme();
  const { event, buffer } = item;
  const past = event.endsAt <= nowMs;
  const running = event.startsAt <= nowMs && nowMs < event.endsAt;
  const rule = ruleColor(event, colors, scheme);

  return (
    <View>
      {buffer ? (
        <View style={styles.row}>
          <Gutter top={formatTime(buffer.startsAt, zone)} muted />
          {/* Hollow node: the travel block is a lead-in, not the appointment. */}
          <Spine top={!first} hollow tint={colors.border} />
          <View style={styles.column}>
            <Card
              padded={false}
              accent={rule ?? colors.border}
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
        <Gutter top={formatTime(event.startsAt, zone)} muted={past} />
        <Spine top={!first || Boolean(buffer)} bottom={!last} tint={rule} />
        <View style={styles.column}>
          <Card
            accent={rule}
            onPress={() => onOpen({ event, buffer })}
            style={buffer ? styles.attachedBottom : undefined}
          >
            <View style={styles.cardInner}>
              <View style={{ flex: 1, gap: 3 }}>
                <Txt variant="bodyStrong" tone={past ? 'secondary' : 'primary'} numberOfLines={2}>
                  {event.title}
                </Txt>
                <Meta
                  duration={formatDuration(durationMinutes(event.startsAt, event.endsAt))}
                  until={formatTime(event.endsAt, zone)}
                  location={event.location}
                  running={running}
                />
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
  first,
  last,
}: {
  item: Extract<AgendaItem, { type: 'class' }>;
  zone: string;
  nowMs: number;
  first: boolean;
  last: boolean;
}) {
  const { colors, scheme } = useTheme();
  const { entry } = item.slot;
  const past = item.endsAt <= nowMs;
  const running = item.startsAt <= nowMs && nowMs < item.endsAt;
  const tint = entry.color ?? colorForTag(entry.subjectName, scheme);
  const meta = [entry.location, entry.teacher].filter(Boolean).join(' · ');

  return (
    <View style={styles.row}>
      <Gutter top={formatTime(item.startsAt, zone)} muted={past} />
      <Spine top={!first} bottom={!last} tint={tint} />
      {/* Not pressable: the timetable is edited on its own screen, and a card
          that opens nothing is worse than one that is plainly static. */}
      <View style={styles.column}>
        <Card accent={tint}>
          <View style={styles.cardInner}>
            <View style={{ flex: 1, gap: 3 }}>
              <Txt variant="bodyStrong" tone={past ? 'secondary' : 'primary'} numberOfLines={2}>
                {entry.subjectName}
              </Txt>
              <Meta
                duration={formatDuration(durationMinutes(item.startsAt, item.endsAt))}
                until={formatTime(item.endsAt, zone)}
                location={meta || null}
                running={running}
              />
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

/**
 * One line under every title: how long it runs, when it ends, and where.
 *
 * The duration used to sit in the gutter under the start time, which put two
 * unrelated numbers in one column and left the card saying only its own name.
 * `until` is the fact the old layout never carried at all — a start time and a
 * duration is arithmetic; a start and an end is a schedule.
 */
function Meta({
  duration,
  until,
  location,
  running,
}: {
  duration: string;
  until: string;
  location: string | null;
  running: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.metaRow}>
      {running ? <View style={[styles.livePip, { backgroundColor: colors.accent }]} /> : null}
      <Txt variant="caption" tone={running ? 'accent' : 'tertiary'} numberOfLines={1}>
        {running ? 'Now · ' : ''}
        {duration} · until {until}
      </Txt>
      {location ? (
        <>
          <Txt variant="caption" tone="tertiary">
            ·
          </Txt>
          <Ionicons name="location-outline" size={12} color={colors.textTertiary} />
          <Txt variant="caption" tone="tertiary" numberOfLines={1} style={{ flex: 1 }}>
            {location}
          </Txt>
        </>
      ) : null}
    </View>
  );
}

function Gutter({ top, muted }: { top: string; muted?: boolean }) {
  return (
    <View style={[styles.gutter, { width: gutterWidth() }]}>
      <Txt variant="mono" tone={muted ? 'tertiary' : 'secondary'} style={styles.gutterTime}>
        {top}
      </Txt>
    </View>
  );
}

/** Where the clock has got to, drawn on the spine like everything else. */
function NowLine({
  at,
  zone,
  tail,
  head,
}: {
  at: number;
  zone: string;
  /** Nothing below it — the clock has passed everything on this day. */
  tail?: boolean;
  /** Nothing above it — the day has not started. */
  head?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.row, styles.nowRow]} accessibilityLabel="Now">
      <View style={[styles.gutter, { width: gutterWidth() }]}>
        <Txt variant="micro" style={{ color: colors.accent, textAlign: 'right' }}>
          {formatTime(at, zone)}
        </Txt>
      </View>
      <Spine top={!head} bottom={!tail} tint={colors.accent} />
      <View style={styles.nowTrack}>
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
    local_only: {
      icon: 'phone-portrait-outline',
      color: colors.textTertiary,
      label: 'On this device only',
    },
  } as const;
  const entry = map[status];
  return (
    <Ionicons name={entry.icon} size={13} color={entry.color} accessibilityLabel={entry.label} />
  );
}

function AgendaSkeleton() {
  const { colors, radius, spacing } = useTheme();
  return (
    <View style={{ gap: spacing.sm }} accessibilityLabel="Loading day">
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.row}>
          <View style={[styles.gutter, { width: gutterWidth(), paddingTop: 4 }]}>
            <View
              style={[
                styles.bone,
                {
                  width: 34,
                  height: 10,
                  backgroundColor: colors.surfaceRaised,
                  borderRadius: radius.sm,
                },
              ]}
            />
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
function ruleColor(event: CalendarEvent, colors: Colors, scheme: ColorScheme): string | undefined {
  if (event.kind === 'exam') return colors.danger;
  if (event.kind === 'event') return undefined;
  return colorForTag(event.kind, scheme);
}

const styles = StyleSheet.create({
  /**
   * `Button` sets `alignSelf: 'flex-start'` so it does not stretch to the
   * full width of a *column*. On a row that same declaration means the top,
   * and it beats the row's own `alignItems`. Only the caller knows which axis
   * it is on, so the caller says.
   */
  centreOnRow: { alignSelf: 'center' },
  scroll: { flex: 1 },
  heading: { paddingTop: 4, paddingBottom: 2, gap: 1 },
  // No gap: the spine column carries its own air, and a row gap would break
  // the rule between one row and the next.
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  gutter: { width: GUTTER_WIDTH, alignItems: 'flex-end', paddingTop: 10 },
  gutterTime: { textAlign: 'right' },
  /**
   * The rule is absolutely positioned inside a column that stretches to the
   * row's height, which is what makes it continuous: a rule drawn as a flex
   * child would be sized by its own content and leave a break at every card
   * boundary. `alignSelf: 'stretch'` is doing the work — without it the column
   * is as tall as the node and the rule disappears.
   */
  spine: { width: SPINE_WIDTH, alignSelf: 'stretch' },
  spineFill: { width: SPINE_WIDTH, alignSelf: 'stretch', alignItems: 'center' },
  spineRail: {
    position: 'absolute',
    left: (SPINE_WIDTH - 1) / 2,
    width: 1,
  },
  spineRailStatic: { width: 1, flex: 1 },
  spineNode: {
    position: 'absolute',
    left: (SPINE_WIDTH - NODE) / 2,
    width: NODE,
    height: NODE,
    borderRadius: NODE / 2,
    borderWidth: 1.5,
  },
  joinRow: { flexDirection: 'row', alignItems: 'stretch', minHeight: 26 },
  joinLabel: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 10,
  },
  // Card's own Pressable wrapper does not stretch, so the row's flex lives here.
  column: { flex: 1, paddingLeft: 10, paddingVertical: 4 },
  attachedTop: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderBottomWidth: 0 },
  attachedBottom: { borderTopLeftRadius: 0, borderTopRightRadius: 0 },
  cardInner: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bufferInner: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  allDayRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  livePip: { width: 5, height: 5, borderRadius: 2.5 },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nowRow: { paddingVertical: 2 },
  nowTrack: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingLeft: 10, height: 26 },
  nowRule: { flex: 1, height: StyleSheet.hairlineWidth },
  bone: { alignSelf: 'flex-end' },
});
