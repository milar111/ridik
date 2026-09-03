import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { now } from '@/core/clock';
import { currentZone, localDateOf, type LocalDate } from '@/core/time';
import {
  AgendaList,
  EventSheet,
  MonthGrid,
  MonthJumpSheet,
  SyncBanner,
  WeekStrip,
  addWeeks,
  buildAgenda,
  classesOnDate,
  epochOfDate,
  formatMonthLabel,
  monthGrid,
  monthOfWeek,
  startOfWeek,
  type EventSheetTarget,
  type WeekStart,
} from '@/features/calendar';
import { useCalendarRange, useCurriculumEntries, useSetting, useSettings } from '@/hooks';
import { BackControl, Divider, Screen, Segmented, Txt } from '@/ui/components';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';

/**
 * One schedule, three ways of looking at it.
 *
 * **Day** is the agenda — what is next, and only what is there. **Week** and
 * **Month** are grids, and they exist because an agenda cannot answer the other
 * two questions anybody asks a calendar: what does my week look like, and where
 * in the month was that thing. Those need the empty space that the agenda
 * deliberately refuses to spend pixels on.
 *
 * The three share one `selected` day and one `visibleWeek`, so switching view
 * never moves you: pick a day in Month, land on it in Day.
 *
 * The strip and the agenda hold separate state on purpose — swiping is a
 * look-ahead, and it must not silently move the day you are working on.
 */

const VIEWS = [
  { value: 'day' as const, label: 'Day' },
  { value: 'month' as const, label: 'Month' },
];
export default function CalendarScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();

  const zone = useMemo(() => currentZone(), []);
  const settings = useSettings();
  const weekStartsOn: WeekStart = settings.data?.weekStartsOn ?? 1;
  const googleConnected = Boolean(settings.data?.googleAccountEmail);

  const [selected, setSelected] = useState<LocalDate>(() => localDateOf(now(), zone));
  const [visibleWeek, setVisibleWeek] = useState(() => startOfWeek(now(), zone, weekStartsOn));
  // Remembered, not screen state — see `calendarView` in `settings.ts`.
  const view = useSetting('calendarView');
  const mode = view.value;
  const [monthOpen, setMonthOpen] = useState(false);
  const [target, setTarget] = useState<EventSheetTarget | null>(null);
  // Bumped to re-aim the strip even when the selected day itself has not moved.
  const [revealNonce, setRevealNonce] = useState(0);

  const curriculum = useCurriculumEntries(true);

  // The span the current view needs, and nothing more. Day asks for nothing
  // here — `AgendaList` has its own per-day query and its own cache entry, and
  // making it share this one would refetch a whole month to add one event.
  const monthAnchor = useMemo(() => monthOfWeek(visibleWeek, zone), [visibleWeek, zone]);
  const cells = useMemo(
    () => monthGrid(monthAnchor, zone, weekStartsOn),
    [monthAnchor, zone, weekStartsOn],
  );
  const span = useMemo(() => {
    const from = epochOfDate(cells[0]!, zone);
    return { from, to: addWeeks(from, 6, zone) };
  }, [cells, zone]);

  const range = useCalendarRange(span.from, span.to, { enabled: mode !== 'day' });
  const items = useMemo(() => {
    if (mode === 'day') return [];
    const classes = cells.flatMap((date) =>
      classesOnDate(curriculum.data ?? [], date, zone),
    );
    return buildAgenda(range.data ?? [], classes);
  }, [mode, cells, curriculum.data, range.data, zone]);

  // The stored week start arrives after the first paint; re-align the strip to
  // it rather than leaving the header a day out until the next swipe.
  useEffect(() => {
    setVisibleWeek((current) => startOfWeek(current, zone, weekStartsOn));
  }, [weekStartsOn, zone]);

  const reveal = useCallback(
    (date: LocalDate) => {
      setSelected(date);
      setVisibleWeek(startOfWeek(epochOfDate(date, zone), zone, weekStartsOn));
      setRevealNonce((n) => n + 1);
    },
    [weekStartsOn, zone],
  );

  const monthPress = usePressScale({ scale: 0.97 });

  return (
    <Screen scroll={false} padded={false} contentStyle={{ flex: 1, gap: 0 }}>
      <View style={[styles.header, { paddingHorizontal: spacing.lg }]}>
        <BackControl />
        <View style={styles.monthSlot}>
          <AnimatedPressable
            accessibilityRole="button"
            accessibilityLabel={`${formatMonthLabel(monthAnchor, zone)}. Jump to another month`}
            onPress={() => setMonthOpen(true)}
            hitSlop={8}
            {...monthPress.handlers}
            style={[styles.monthButton, monthPress.style]}
          >
            <Txt variant="title" numberOfLines={1}>
              {formatMonthLabel(monthAnchor, zone, mode !== 'day')}
            </Txt>
            <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
          </AnimatedPressable>
        </View>
        {/*
          Nothing else. The header is a back chevron and the month, and the
          month is the control.

          It used to carry a paging stepper and a Today button as well, which is
          three ways to move through time in a 40pt row above a grid that is
          itself the fourth. The arrows went first for a reason worth keeping:
          they were originally either side of the label, putting "go back" and
          "previous month" side by side as **identical glyphs a finger's width
          apart**, and pairing them on the right fixed the ambiguity without
          fixing the redundancy. Tapping the month opens a picker that reaches
          any month in one gesture, which is what somebody who wants a different
          month actually does — and Today is a day, on a screen whose whole
          bottom half is the day you selected.
        */}
      </View>

      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        <Segmented options={VIEWS} value={mode} onChange={view.set} />
      </View>

      {settings.isSuccess && !googleConnected ? (
        <View style={{ paddingBottom: spacing.sm }}>
          <SyncBanner onPress={() => router.push('/settings')} />
        </View>
      ) : null}

      {mode === 'day' ? (
        <>
          <WeekStrip
            selected={selected}
            onSelect={setSelected}
            onWeekChange={setVisibleWeek}
            zone={zone}
            weekStartsOn={weekStartsOn}
            classes={curriculum.data ?? []}
            revealNonce={revealNonce}
          />
          <Divider />
          <ErrorBoundary label="calendar agenda">
            <AgendaList date={selected} zone={zone} onOpen={setTarget} />
          </ErrorBoundary>
        </>
      ) : (
        <View style={styles.grid}>
          <ErrorBoundary label="calendar month">
            {/* Only the grid is padded — `AgendaList` carries its own, and
                wrapping both would inset the day twice. */}
            <View style={{ paddingHorizontal: spacing.lg }}>
              <MonthGrid
                cells={cells}
                anchor={monthAnchor}
                items={items}
                zone={zone}
                weekStartsOn={weekStartsOn}
                selected={selected}
                // Selects, never navigates: the day it selects is already on
                // screen underneath. Sending somebody to another view to read a
                // day they can see is what this layout exists to avoid.
                onSelectDate={setSelected}
              />
            </View>
            <Divider />
            <ErrorBoundary label="calendar month agenda">
              <AgendaList date={selected} zone={zone} onOpen={setTarget} />
            </ErrorBoundary>
          </ErrorBoundary>
        </View>
      )}

      <MonthJumpSheet
        visible={monthOpen}
        anchor={visibleWeek}
        selected={selected}
        zone={zone}
        weekStartsOn={weekStartsOn}
        onPick={(date) => {
          setMonthOpen(false);
          reveal(date);
        }}
        onClose={() => setMonthOpen(false)}
      />

      <EventSheet
        target={target}
        zone={zone}
        googleConnected={googleConnected}
        onClose={() => setTarget(null)}
        onMoved={reveal}
      />
    </Screen>
  );
}

/** A chevron sized like the header's other controls, and no bigger. */
const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 6,
    paddingBottom: 10,
    gap: 12,
  },
  // `alignSelf` so it keeps its own width inside the slot rather than
  // stretching, which would make its press scale sweep the whole row.
  monthButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
  },
  // Takes the row so `Today` is pinned right, which `space-between` did while
  // there were exactly two children. It is a plain View rather than `flex: 1`
  // on the button itself: a pressable stretched across the header would open
  // the month sheet from a tap on empty space beside it.
  monthSlot: { flex: 1 },
  step: { height: 40, width: 26, alignItems: 'center', justifyContent: 'center' },
  /** The pair reads as one control; a gap between them would read as two. */
  // The grids size themselves to what is left; `flex: 1` here is what stops a
  // six-row month growing past the screen instead of fitting into it.
  grid: { flex: 1 },
});
