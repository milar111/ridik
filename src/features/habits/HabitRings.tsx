import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import type { LocalDate } from '@/core/time';
import type { Habit } from '@/db/schema';
import { useHabitHistories } from '@/hooks';
import { Card, Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';

import { completionRate, formatRate, summarise, type HabitRate } from './rate';

/**
 * One ring per habit, each carrying the share of its window that was kept.
 *
 * Adopted from the `clay` direction. The grid below has always held this number
 * — thirty-five cells, some of them filled — but reading it means counting
 * squares, and nobody counts squares. The ring is the same record with the
 * arithmetic already done, and the line underneath is the set in one figure.
 *
 * ## Rings here, and not on a widget
 *
 * `WIDGETS.md` §1 bans the circular gauge outright, and that ban stands: a tile
 * is glanced at from across a room, where a ring is a smear and four discrete
 * levels are not. This is a screen the user deliberately opened and is reading —
 * the one context where a proportion is worth more than a bucket. The two rules
 * are about two different distances, so they do not conflict.
 *
 * ## The palette is the app's, not the direction's
 *
 * `clay` drew these in purple with a mint accent. Nothing else in this app is
 * purple, and `AGENTS.md` is explicit that a foreign hue beside this palette
 * reads as a bug rather than as an accent. So the ring is `colors.accent` — the
 * text-safe ember — on an `accentMuted` track, and the direction contributes the
 * *encoding*, not the colours.
 *
 * ## One hook, N habits
 *
 * Every rate here needs its own habit's history, and the summary needs all of
 * them at once. `useHabitHistories` is what makes that legal in one component —
 * a `useHabitHistory` per iteration is the hook-order crash, and a child
 * component per habit cannot hand its number back up to be totalled.
 */

/** Big enough for two digits and a percent sign at `micro`, small enough for a row. */
const SIZE = 56;

/**
 * Columns per row. Four 56pt rings and their names fit the narrowest phone this
 * ships to, and four is the count that leaves a five-habit user a sensible
 * second row rather than a single orphan.
 */
const PER_ROW = 4;
const STROKE = 5;

/**
 * `stroke` straddles the path, so the radius has to be inset by half of it or
 * the ring is clipped by its own viewBox on all four sides.
 */
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export type HabitRingsProps = {
  habits: readonly Habit[];
  /** The same window the grid draws, so the two agree and share one query. */
  gridStart: LocalDate;
  today: LocalDate;
  days: readonly LocalDate[];
};

export function HabitRings({ habits, gridStart, today, days }: HabitRingsProps) {
  const { colors, spacing } = useTheme();

  const ids = useMemo(() => habits.map((habit) => habit.id), [habits]);
  const histories = useHabitHistories(ids, { from: gridStart, to: today });

  const rates = useMemo(
    () =>
      habits.map((habit) => ({
        habit,
        rate: completionRate(days, histories.byHabit[habit.id] ?? EMPTY, today),
      })),
    [habits, histories.byHabit, days, today],
  );

  const total = useMemo(() => summarise(rates.map((entry) => entry.rate)), [rates]);

  // While the histories are in flight every ring would otherwise draw an empty
  // track and a confident "0%", which is the one wrong answer that looks like a
  // real one. Dimmed and blank until they land.
  const known = !histories.pending;
  const weeks = Math.max(1, Math.round(days.length / 7));

  return (
    <Card>
      <View style={{ gap: spacing.sm }}>
        <View style={styles.row}>
          {rates.map(({ habit, rate }) => (
            <Ring key={habit.id} name={habit.name} rate={rate} known={known} />
          ))}
        </View>

        <View style={[styles.summary, { borderTopColor: colors.border }]}>
          <Txt variant="micro" tone="tertiary">
            {`Last ${weeks} weeks`}
          </Txt>
          <Txt variant="micro" tone={known ? 'secondary' : 'tertiary'}>
            {known ? `${total.logged} of ${total.elapsed} days · ${formatRate(total)}` : '—'}
          </Txt>
        </View>
      </View>
    </Card>
  );
}

const EMPTY: ReadonlySet<LocalDate> = new Set();

function Ring({ name, rate, known }: { name: string; rate: HabitRate; known: boolean }) {
  const { colors } = useTheme();
  const swept = Math.min(1, Math.max(0, rate.rate));

  return (
    <View
      style={styles.item}
      accessible
      accessibilityRole="image"
      // The percentage is the whole point of the ring and it is drawn as an arc
      // plus a two-character number; neither is readable without this.
      accessibilityLabel={
        known
          ? `${name}, ${formatRate(rate)}, ${rate.logged} of ${rate.elapsed} days`
          : `${name}, loading`
      }
    >
      <View style={[styles.ring, { opacity: known ? 1 : 0.4 }]}>
        <Svg width={SIZE} height={SIZE}>
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            stroke={colors.accentMuted}
            strokeWidth={STROKE}
            fill="none"
          />
          {known && swept > 0 ? (
            <Circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              stroke={colors.accent}
              strokeWidth={STROKE}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - swept)}
              // Starts the sweep at twelve o'clock rather than three, which is
              // where every progress ring anyone has ever seen begins.
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            />
          ) : null}
        </Svg>
        <View style={styles.readout} pointerEvents="none">
          <Txt variant="micro" weight="700" tone={known ? 'primary' : 'tertiary'}>
            {known ? formatRate(rate) : '·'}
          </Txt>
        </View>
      </View>
      <Txt variant="micro" tone="tertiary" numberOfLines={1} style={styles.name}>
        {name}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * A grid of fixed columns, not a packed row.
   *
   * `gap: 14` around `width: SIZE` items packs them against the left edge, so
   * three habits drew three 56pt rings in the left 45% of a full-width card and
   * left the rest of it empty — which reads as a layout that ran out rather
   * than as a card with room in it. Quarters put each ring on a column centre
   * whatever the count, so an empty slot looks like an empty slot, and a fourth
   * habit lands where the eye already expected one.
   *
   * A percentage rather than a measured width because the card is whatever the
   * screen is wide, and `gap` is deliberately absent: it would be added to
   * four 25% columns and wrap the fourth onto its own row.
   */
  row: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 14 },
  item: { width: `${100 / PER_ROW}%`, gap: 4, alignItems: 'center', paddingHorizontal: 4 },
  ring: { width: SIZE, height: SIZE, position: 'relative' },
  readout: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { alignSelf: 'stretch', textAlign: 'center' },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
});
