/**
 * The month, over the day it opens onto.
 *
 * Six rows of seven, compact, with the selected day's agenda underneath — the
 * arrangement phone calendars have converged on (Samsung's, Outlook's, Teams',
 * Todoist's), and for a good reason: the grid answers *where in the month*, and
 * the moment you have found the day you wanted, the next thing you want is what
 * is actually on it. Making that a selection rather than a navigation is the
 * whole design, and it is why `onSelectDate` does not change view.
 *
 * A cell's events are **bars, not names.** At the height a grid can afford when
 * it is sharing the screen with an agenda, a name is four truncated characters
 * — worse than nothing, because it invites you to read it. A bar says how full
 * the day is and what kind of thing is in it, which is what you scan a month
 * for. It is also this app's own primitive: the heat cell the widgets and the
 * app mark are built from, at the size that fits here.
 *
 * The trade, stated plainly: a day with more events than fit shows only the
 * first few and nothing on the cell says so. That is defensible *here* and
 * would not be on its own — the full list for the selected day is on the same
 * screen, one tap away, and the accessibility label carries the true count.
 */
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { now } from '@/core/clock';
import { formatTime, localDateOf, type LocalDate } from '@/core/time';
import { Txt } from '@/ui/components';
import { inkOn } from '@/ui/ink';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import { colorForTag, type Colors, type ColorScheme } from '@/ui/theme';

import type { AgendaItem } from './agenda';
import { DAYS_IN_WEEK, dayNumberOf, isSameMonth, weekdayInitials, type WeekStart } from './dates';
import { monthCell, titleOf } from './grid';

/**
 * One row of the grid.
 *
 * Fixed, rather than sharing out whatever is left. The agenda below takes the
 * remainder, so a month that grew to fill the screen would push the day off it
 * — and a five-row April would put the agenda 46pt higher than a six-row
 * February, which reads as the screen shifting under your thumb between months.
 */
const ROW_HEIGHT = 46;
/** The day number's line. */
const NUMBER_HEIGHT = 18;
/** A load bar and the gap under it. */
const BAR = 3;
const BAR_GAP = 3;

/** How many bars a row holds. Arithmetic, because the row is a fixed height. */
const BARS = Math.max(1, Math.floor((ROW_HEIGHT - NUMBER_HEIGHT - 3) / (BAR + BAR_GAP)));

export type MonthGridProps = {
  /** 42 dates, Monday- or Sunday-first, from `monthGrid()`. */
  cells: readonly LocalDate[];
  /** Any instant inside the month being shown, for the in/out-of-month wash. */
  anchor: number;
  items: readonly AgendaItem[];
  zone: string;
  weekStartsOn: WeekStart;
  selected: LocalDate;
  /** Selects the day the agenda below shows. It does not navigate. */
  onSelectDate: (date: LocalDate) => void;
};

export function MonthGrid({
  cells,
  anchor,
  items,
  zone,
  weekStartsOn,
  selected,
  onSelectDate,
}: MonthGridProps) {
  const today = localDateOf(now(), zone);
  const initials = weekdayInitials(weekStartsOn);

  const rows = useMemo(() => {
    const out: LocalDate[][] = [];
    for (let i = 0; i < cells.length; i += DAYS_IN_WEEK) {
      out.push(cells.slice(i, i + DAYS_IN_WEEK) as LocalDate[]);
    }
    // A month that fits in five rows gets five. The sixth is empty padding from
    // `monthGrid`, and a blank row of seven cells is a worse lie than a short
    // month: it reads as a week with nothing in it.
    return out.filter((row) => row.some((date) => isSameMonth(date, anchor, zone)));
  }, [cells, anchor, zone]);

  const byDate = useMemo(() => {
    const map = new Map<LocalDate, AgendaItem[]>();
    for (const row of rows) {
      for (const date of row) map.set(date, monthCell(items, date, zone));
    }
    return map;
  }, [rows, items, zone]);

  return (
    <View>
      <View style={styles.header}>
        {initials.map((label, index) => (
          <View key={`${label}-${index}`} style={styles.headerCell}>
            <Txt variant="micro" tone="tertiary">
              {label}
            </Txt>
          </View>
        ))}
      </View>

      {rows.map((row, index) => (
        <View key={row[0]} style={styles.row}>
          {row.map((date) => (
            <Cell
              key={date}
              date={date}
              items={byDate.get(date) ?? []}
              zone={zone}
              inMonth={isSameMonth(date, anchor, zone)}
              isToday={date === today}
              isSelected={date === selected}
              onPress={() => onSelectDate(date)}
              rank={index}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

function Cell({
  date,
  items,
  zone,
  inMonth,
  isToday,
  isSelected,
  onPress,
  rank,
}: {
  date: LocalDate;
  items: readonly AgendaItem[];
  zone: string;
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  onPress: () => void;
  rank: number;
}) {
  const { colors, radius, scheme } = useTheme();
  const press = usePressScale({ scale: 0.94 });
  const shown = items.slice(0, BARS);

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      accessibilityLabel={label(date, zone, items)}
      onPress={onPress}
      {...press.handlers}
      style={[
        styles.cell,
        { borderRadius: radius.sm },
        // No weekend wash. At a 46pt cell it draws a tall rounded rectangle
        // behind an empty Saturday, which reads as a placeholder card rather
        // than as a quieter day — the numbers and the bars already say which
        // days are quiet. The week grid, whose columns are 600pt tall, keeps
        // its wash: the same paint at a different size is a different thing.
        //
        // An outline for the selection, not a fill: a filled cell would compete
        // with today's pill sitting inside it, and the two are different facts
        // — where you are looking, and what day it is.
        isSelected ? { borderColor: colors.accent, borderWidth: 1 } : null,
        press.style,
      ]}
    >
      <View style={[styles.numberPill, isToday ? { backgroundColor: colors.accent } : null]}>
        <Txt
          variant="micro"
          weight={isToday || isSelected ? '600' : undefined}
          style={isToday ? { color: inkOn(colors.accent) } : undefined}
          // Out-of-month days are drawn, not hidden: the week that straddles
          // two months is one week, and blanking half of it breaks the row.
          tone={isToday ? undefined : inMonth ? 'primary' : 'tertiary'}
        >
          {String(dayNumberOf(date, zone))}
        </Txt>
      </View>

      <View style={styles.bars}>
        {shown.map((item, index) => (
          <Animated.View
            key={item.key}
            entering={FadeIn.duration(160).delay(rank * 20 + index * 6)}
            style={[
              styles.bar,
              { backgroundColor: tintOf(item, colors, scheme), opacity: inMonth ? 0.85 : 0.28 },
            ]}
          />
        ))}
      </View>
    </AnimatedPressable>
  );
}

/** What a screen reader gets: the date, the day's load, then the first few. */
function label(date: LocalDate, zone: string, items: readonly AgendaItem[]): string {
  const day = dayNumberOf(date, zone);
  if (items.length === 0) return `${day}, nothing on`;
  const first = items
    .slice(0, 3)
    .map((item) =>
      item.allDay ? titleOf(item) : `${formatTime(item.startsAt, zone)} ${titleOf(item)}`,
    )
    .join(', ');
  return `${day}, ${items.length === 1 ? '1 thing' : `${items.length} things`}: ${first}`;
}

/** The same rule the agenda and the week grid use. One thing, one colour. */
function tintOf(item: AgendaItem, colors: Colors, scheme: ColorScheme): string {
  if (item.type === 'class') {
    return item.slot.entry.color ?? colorForTag(item.slot.entry.subjectName, scheme);
  }
  if (item.event.kind === 'exam') return colors.danger;
  if (item.event.kind === 'event') return colors.accent;
  return colorForTag(item.event.kind, scheme);
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', paddingBottom: 4 },
  headerCell: { flex: 1, alignItems: 'center' },
  row: { flexDirection: 'row', height: ROW_HEIGHT },
  // No hairlines between cells. At this size a grid of rules weighs more than
  // what it contains, and seven numbers in a row already read as a grid.
  cell: { flex: 1, alignItems: 'center', paddingTop: 1, marginHorizontal: 1 },
  numberPill: {
    minWidth: NUMBER_HEIGHT,
    height: NUMBER_HEIGHT,
    borderRadius: NUMBER_HEIGHT / 2,
    paddingHorizontal: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bars: { alignSelf: 'stretch', paddingHorizontal: 4, paddingTop: 2, gap: BAR_GAP },
  /** A stadium, like every other heat cell in this app. */
  bar: { height: BAR, borderRadius: BAR / 2 },
});
