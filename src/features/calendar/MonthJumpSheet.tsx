import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { now } from '@/core/clock';
import { dayRange, localDateOf, type LocalDate } from '@/core/time';
import { useCalendarRange } from '@/hooks';
import { Button, DialogCard, Txt } from '@/ui/components';
import { AnimatedPressable, useMountPop, usePressScale } from '@/ui/motionHooks';
import { useTheme } from '@/ui/ThemeProvider';

import { countByDate } from './agenda';
import {
  DAYS_IN_WEEK,
  addMonths,
  dayNumberOf,
  epochOfDate,
  formatMonthLabel,
  isSameMonth,
  monthGrid,
  weekdayInitials,
  type WeekStart,
} from './dates';

/** Foreground on an accent fill; the palette has no "on-accent" token. */
const ON_ACCENT = '#FFFFFF';

export type MonthJumpSheetProps = {
  visible: boolean;
  /** The month to open on — normally the week the strip is showing. */
  anchor: number;
  selected: LocalDate;
  zone: string;
  weekStartsOn: WeekStart;
  onPick: (date: LocalDate) => void;
  onClose: () => void;
};

/**
 * Jumping months without leaving the day view: six rows, a dot where something
 * is scheduled, and one tap back to the agenda.
 */
export function MonthJumpSheet({
  visible,
  anchor,
  selected,
  zone,
  weekStartsOn,
  onPick,
  onClose,
}: MonthJumpSheetProps) {
  const { colors, radius, spacing } = useTheme();
  const [cursor, setCursor] = useState(anchor);
  // Above the early-return-free render, but stated for the same reason the
  // extracted rows below exist: a hook may not be called from inside a `map`.
  const prevPress = usePressScale({ scale: 0.86 });
  const nextPress = usePressScale({ scale: 0.86 });

  useEffect(() => {
    if (visible) setCursor(anchor);
  }, [anchor, visible]);

  const today = localDateOf(now(), zone);
  const cells = useMemo(() => monthGrid(cursor, zone, weekStartsOn), [cursor, weekStartsOn, zone]);
  const letters = weekdayInitials(weekStartsOn);

  const rangeFrom = epochOfDate(cells[0]!, zone);
  const rangeTo = dayRange(cells[cells.length - 1]!, zone).end;
  const { data } = useCalendarRange(rangeFrom, rangeTo, { enabled: visible });
  const counts = useMemo(() => countByDate(data ?? [], zone), [data, zone]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close month picker"
        style={[styles.backdrop, { backgroundColor: colors.overlay }]}
        onPress={onClose}
      />
      <View style={styles.centre} pointerEvents="box-none">
        {/*
         * The card arrives as one object.
         *
         * Forty-two day cells staggering in would be the obvious reading of "a
         * grid arrives", and it is wrong twice over. It is inside a React
         * Native `Modal`, where Reanimated's `entering` does not reliably get
         * the layout pass it needs — so the animation would be a coin toss
         * rather than a choice — and a picker you opened to tap a date in
         * cannot spend a third of a second assembling itself under your thumb.
         * `DialogCard` is the centred-dialog entrance for exactly this: no edge
         * to slide from, so it grows the last few per cent instead.
         */}
        <DialogCard
          style={[
            styles.card,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderRadius: radius.lg,
              gap: spacing.sm,
            },
          ]}
        >
          <View style={styles.header}>
            <AnimatedPressable
              accessibilityRole="button"
              accessibilityLabel="Previous month"
              hitSlop={10}
              onPress={() => setCursor((c) => addMonths(c, -1, zone))}
              {...prevPress.handlers}
              style={prevPress.style}
            >
              <Ionicons name="chevron-back" size={20} color={colors.textSecondary} />
            </AnimatedPressable>
            <Txt variant="heading">{formatMonthLabel(cursor, zone)}</Txt>
            <AnimatedPressable
              accessibilityRole="button"
              accessibilityLabel="Next month"
              hitSlop={10}
              onPress={() => setCursor((c) => addMonths(c, 1, zone))}
              {...nextPress.handlers}
              style={nextPress.style}
            >
              <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
            </AnimatedPressable>
          </View>

          <View style={styles.week}>
            {letters.map((letter, i) => (
              <View key={`${letter}-${i}`} style={styles.cell}>
                <Txt variant="micro" tone="tertiary">
                  {letter}
                </Txt>
              </View>
            ))}
          </View>

          {/* Keyed on the month, so stepping remounts the grid and it arrives
              rather than cutting. Six rows of numbers all changing in one frame
              is the one moment in this sheet where you cannot tell whether the
              tap registered. */}
          <MonthBody key={cursor}>
            {cells.map((date) => (
              <MonthCell
                key={date}
                date={date}
                zone={zone}
                inMonth={isSameMonth(date, cursor, zone)}
                isSelected={date === selected}
                isToday={date === today}
                busy={(counts.get(date) ?? 0) > 0}
                onPress={() => onPick(date)}
              />
            ))}
          </MonthBody>

          <View style={styles.actions}>
            <Button label="Today" icon="today-outline" onPress={() => onPick(today)} />
            <Button label="Close" variant="ghost" onPress={onClose} />
          </View>
        </DialogCard>
      </View>
    </Modal>
  );
}

/**
 * The 6×7 grid, mounted fresh for each month so a step reads as a change.
 *
 * The same entrance the card itself uses, only shallower: a month has no
 * direction to come from either — forward and back are a fiction of where the
 * chevrons sit — so it grows into place rather than sliding. Inside a `Modal`,
 * which is why this is `useMountPop` and not an `entering` prop.
 */
function MonthBody({ children }: { children: ReactNode }) {
  const motion = useMountPop({ from: 0.97 });
  return <Animated.View style={[styles.grid, motion]}>{children}</Animated.View>;
}

/**
 * One day.
 *
 * Its own component because a hook cannot be called from inside a `map`, and
 * these forty-two cells were the largest group of controls in the app with no
 * press feedback at all — a picker whose entire purpose is one tap.
 */
function MonthCell({
  date,
  zone,
  inMonth,
  isSelected,
  isToday,
  busy,
  onPress,
}: {
  date: LocalDate;
  zone: string;
  inMonth: boolean;
  isSelected: boolean;
  isToday: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const { colors, radius } = useTheme();
  const press = usePressScale();
  return (
    <AnimatedPressable
      testID={`month-day-${date}`}
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      accessibilityLabel={date}
      onPress={onPress}
      {...press.handlers}
      style={[styles.cell, press.style]}
    >
      <View
        style={[
          styles.dayPill,
          {
            borderRadius: radius.pill,
            backgroundColor: isSelected ? colors.accent : 'transparent',
            borderColor: isToday && !isSelected ? colors.accent : 'transparent',
          },
        ]}
      >
        <Txt
          variant="caption"
          style={{
            color: isSelected
              ? ON_ACCENT
              : isToday
                ? colors.accent
                : inMonth
                  ? colors.text
                  : colors.textTertiary,
          }}
        >
          {dayNumberOf(date, zone)}
        </Txt>
      </View>
      <View
        style={[
          styles.dot,
          { backgroundColor: busy ? (isSelected ? ON_ACCENT : colors.textTertiary) : 'transparent' },
        ]}
      />
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  centre: { flex: 1, justifyContent: 'center', paddingHorizontal: 20 },
  card: { padding: 14, borderWidth: StyleSheet.hairlineWidth },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  week: { flexDirection: 'row' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / DAYS_IN_WEEK}%`, alignItems: 'center', paddingVertical: 3, gap: 2 },
  dayPill: {
    width: 30,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 4, height: 4, borderRadius: 2 },
  actions: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end', paddingTop: 2 },
});
