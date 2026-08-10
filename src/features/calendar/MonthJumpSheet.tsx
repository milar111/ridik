import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { now } from '@/core/clock';
import { dayRange, localDateOf, type LocalDate } from '@/core/time';
import { useCalendarRange } from '@/hooks';
import { Button, Txt } from '@/ui/components';
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
        <View
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
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous month"
              hitSlop={10}
              onPress={() => setCursor((c) => addMonths(c, -1, zone))}
            >
              <Ionicons name="chevron-back" size={20} color={colors.textSecondary} />
            </Pressable>
            <Txt variant="heading">{formatMonthLabel(cursor, zone)}</Txt>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next month"
              hitSlop={10}
              onPress={() => setCursor((c) => addMonths(c, 1, zone))}
            >
              <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
            </Pressable>
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

          <View style={styles.grid}>
            {cells.map((date) => {
              const inMonth = isSameMonth(date, cursor, zone);
              const isSelected = date === selected;
              const isToday = date === today;
              const busy = (counts.get(date) ?? 0) > 0;
              return (
                <Pressable
                  key={date}
                  testID={`month-day-${date}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={date}
                  onPress={() => onPick(date)}
                  style={styles.cell}
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
                      {
                        backgroundColor: busy
                          ? isSelected
                            ? ON_ACCENT
                            : colors.textTertiary
                          : 'transparent',
                      },
                    ]}
                  />
                </Pressable>
              );
            })}
          </View>

          <View style={styles.actions}>
            <Button label="Today" icon="today-outline" onPress={() => onPick(today)} />
            <Button label="Close" variant="ghost" onPress={onClose} />
          </View>
        </View>
      </View>
    </Modal>
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
