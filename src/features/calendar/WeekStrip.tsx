import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  FlatList,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import * as Haptics from 'expo-haptics';

import { now } from '@/core/clock';
import { formatDayHeading, localDateOf, type LocalDate } from '@/core/time';
import type { CurriculumEntry } from '@/db/schema';
import { useCalendarRange } from '@/hooks';
import { Txt } from '@/ui/components';
import { inkOn } from '@/ui/ink';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';

import { classesOnDate, countByDate, densityDots } from './agenda';
import {
  addWeeks,
  dayNumberOf,
  epochOfDate,
  isWeekend,
  startOfWeek,
  weekDates,
  weekdayIndexOf,
  weekdayInitials,
  weeksBetween,
  type WeekStart,
} from './dates';

/** Two years either way — far enough that nobody swipes off the end. */
const WEEKS_EACH_WAY = 104;
const PAGE_COUNT = WEEKS_EACH_WAY * 2 + 1;
const CELL_HEIGHT = 58;

export type WeekStripProps = {
  selected: LocalDate;
  onSelect: (date: LocalDate) => void;
  /** Fires when a swipe lands on a different week, so the header can follow. */
  onWeekChange?: (weekStart: number) => void;
  zone: string;
  weekStartsOn: WeekStart;
  /** Timetable rows, so a school day is not shown as an empty one. */
  classes: readonly CurriculumEntry[];
  /** Bumped by "Today" and the month jump to force the strip back into view. */
  revealNonce?: number;
};

/**
 * Seven day cells, paged by week.
 *
 * Paging is a windowed FlatList rather than a three-page carousel: recentring a
 * carousel mid-gesture visibly jumps, and `getItemLayout` lets us scroll
 * straight to an arbitrary week when the user jumps months.
 */
export function WeekStrip({
  selected,
  onSelect,
  onWeekChange,
  zone,
  weekStartsOn,
  classes,
  revealNonce = 0,
}: WeekStripProps) {
  const { width } = useWindowDimensions();
  const listRef = useRef<FlatList<number>>(null);
  const pageRef = useRef(-1);

  // Frozen on mount: a base that drifted would renumber every page mid-scroll.
  const base = useMemo(() => startOfWeek(now(), zone, weekStartsOn), [zone, weekStartsOn]);
  const today = localDateOf(now(), zone);

  const weekStartAt = useCallback(
    (index: number) => addWeeks(base, index - WEEKS_EACH_WAY, zone),
    [base, zone],
  );

  const selectedIndex = useMemo(() => {
    const weekStart = startOfWeek(epochOfDate(selected, zone), zone, weekStartsOn);
    const index = WEEKS_EACH_WAY + weeksBetween(base, weekStart, zone);
    return Math.min(Math.max(index, 0), PAGE_COUNT - 1);
  }, [base, selected, weekStartsOn, zone]);

  useEffect(() => {
    if (pageRef.current === -1) {
      // First layout is handled by initialScrollIndex.
      pageRef.current = selectedIndex;
      return;
    }
    pageRef.current = selectedIndex;
    listRef.current?.scrollToIndex({ index: selectedIndex, animated: true });
    // `revealNonce` is a deliberate trigger: pressing Today must return the
    // strip even when the selected day never changed.
  }, [selectedIndex, revealNonce, width]);

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const page = Math.round(event.nativeEvent.contentOffset.x / Math.max(1, width));
      if (page === pageRef.current) return;
      pageRef.current = page;
      onWeekChange?.(weekStartAt(page));
    },
    [onWeekChange, weekStartAt, width],
  );

  const pages = useMemo(() => Array.from({ length: PAGE_COUNT }, (_, i) => i), []);

  return (
    <FlatList
      ref={listRef}
      testID="week-strip"
      data={pages}
      keyExtractor={(index) => String(index)}
      horizontal
      pagingEnabled
      showsHorizontalScrollIndicator={false}
      initialScrollIndex={selectedIndex}
      getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
      // Only the neighbouring weeks stay mounted; each page runs its own range
      // query and a wider window would fire a dozen of them per swipe.
      windowSize={3}
      initialNumToRender={1}
      maxToRenderPerBatch={2}
      onMomentumScrollEnd={onMomentumEnd}
      style={{ flexGrow: 0 }}
      renderItem={({ item }) => (
        <WeekPage
          weekStart={weekStartAt(item)}
          width={width}
          zone={zone}
          classes={classes}
          selected={selected}
          today={today}
          onSelect={onSelect}
        />
      )}
    />
  );
}

type WeekPageProps = {
  weekStart: number;
  width: number;
  zone: string;
  classes: readonly CurriculumEntry[];
  selected: LocalDate;
  today: LocalDate;
  onSelect: (date: LocalDate) => void;
};

const WeekPage = memo(function WeekPage({
  weekStart,
  width,
  zone,
  classes,
  selected,
  today,
  onSelect,
}: WeekPageProps) {
  const dates = useMemo(() => weekDates(weekStart, zone), [weekStart, zone]);
  const weekEnd = useMemo(() => addWeeks(weekStart, 1, zone), [weekStart, zone]);
  const { data } = useCalendarRange(weekStart, weekEnd);

  const counts = useMemo(() => {
    const byDate = countByDate(data ?? [], zone);
    // The timetable is half the schedule, so a day of classes must show dots
    // even when nothing one-off was ever added to it.
    for (const date of dates) {
      const lessons = classesOnDate(classes, date, zone).length;
      if (lessons > 0) byDate.set(date, (byDate.get(date) ?? 0) + lessons);
    }
    return byDate;
  }, [classes, data, dates, zone]);

  return (
    <View style={[styles.page, { width }]}>
      {dates.map((date) => (
        <DayCell
          key={date}
          date={date}
          zone={zone}
          count={counts.get(date) ?? 0}
          selected={date === selected}
          isToday={date === today}
          onSelect={onSelect}
        />
      ))}
    </View>
  );
});

function DayCell({
  date,
  zone,
  count,
  selected,
  isToday,
  onSelect,
}: {
  date: LocalDate;
  zone: string;
  count: number;
  selected: boolean;
  isToday: boolean;
  onSelect: (date: LocalDate) => void;
}) {
  const { colors, radius } = useTheme();
  const epoch = epochOfDate(date, zone);
  const weekend = isWeekend(date, zone);

  // Only the number is *inside* the accent pill. The letter above it and the
  // dots below it sit on the page's own ground, where the on-fill ink would be
  // linen on sand — which is how a selected day's initial and its density dots
  // were being drawn in pure white on a near-white field. They take the accent.
  const numberColor = selected
    ? inkOn(colors.accent)
    : isToday
      ? colors.accent
      : weekend
        ? colors.textTertiary
        : colors.text;
  const dotColor = selected || isToday ? colors.accent : colors.textTertiary;
  // A seventh of the width: small enough for the full press travel. The cell
  // keeps its `height` and its `flex`, so a scaled cell does not move its
  // neighbours or shrink the target.
  const press = usePressScale();

  return (
    <AnimatedPressable
      testID={`day-${date}`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={formatDayHeading(epoch, zone)}
      accessibilityHint={count > 0 ? `${count} scheduled` : 'Nothing scheduled'}
      onPress={() => {
        void Haptics.selectionAsync().catch(() => {});
        onSelect(date);
      }}
      {...press.handlers}
      style={[styles.cell, press.style]}
    >
      <Txt variant="micro" style={{ color: selected ? colors.accent : colors.textTertiary }}>
        {WEEKDAY_LETTERS[weekdayIndexOf(date, zone)]}
      </Txt>
      <View
        style={[
          styles.pill,
          {
            borderRadius: radius.pill,
            backgroundColor: selected ? colors.accent : 'transparent',
            borderColor: isToday && !selected ? colors.accent : 'transparent',
          },
        ]}
      >
        <Txt variant="bodyStrong" style={{ color: numberColor }}>
          {dayNumberOf(date, zone)}
        </Txt>
      </View>
      <View style={styles.dots}>
        {Array.from({ length: densityDots(count) }, (_, i) => (
          <View key={i} style={[styles.dot, { backgroundColor: dotColor }]} />
        ))}
      </View>
    </AnimatedPressable>
  );
}

/** Always Monday-first: the cell letter labels the date, not the strip order. */
const WEEKDAY_LETTERS = weekdayInitials(1);

const styles = StyleSheet.create({
  page: { flexDirection: 'row' },
  cell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    height: CELL_HEIGHT,
  },
  pill: {
    minWidth: 30,
    height: 26,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  dots: { flexDirection: 'row', gap: 3, height: 5, alignItems: 'center' },
  dot: { width: 4, height: 4, borderRadius: 2 },
});
