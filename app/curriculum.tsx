/**
 * The weekly programme.
 *
 * Two views of one table: a grid for "what does Tuesday look like" and a list
 * for "when exactly is Physics and who teaches it". The grid is the default
 * because the recurring shape of a week is the thing a timetable is for.
 *
 * Every subject carries its next occurrence, because that instant is not
 * cosmetic: it is precisely what homework inference resolves a due date
 * against, and a wrong parity or a switched-off row is only visible here.
 */
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { TIME_OF_DAY_RE, formatDayHeading, formatTime } from '@/core/time';
import { countLabel } from '@/core/format';
import {
  useAddCurriculumEntries,
  useCurriculumEntries,
  useDeleteCurriculumEntry,
  useSetting,
  useUpcomingClasses,
  useUpdateCurriculumEntry,
} from '@/hooks';
import type { CurriculumEntry } from '@/db/schema';
import type { WeekParity } from '@/repositories/curriculum';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { REFLOW_MS } from '@/ui/motion';
import { useStaggeredEntry, AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import { useTheme } from '@/ui/ThemeProvider';
import { colorForTag } from '@/ui/theme';
import {
  Badge,
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  Input,
  Screen,
  Section,
  Segmented,
  SheetCard,
  Txt,
  useToast,
} from '@/ui/components';

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_INITIAL = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** Pixels per hour in the grid. Tight enough that a full week fits two thumbs. */
const HOUR_HEIGHT = 38;
const GUTTER_WIDTH = 30;
const MIN_BLOCK_HEIGHT = 20;

const PARITY_LABEL: Record<WeekParity, string> = {
  every: 'Every week',
  odd: 'Odd weeks',
  even: 'Even weeks',
};

type Draft = {
  id: string | null;
  subjectName: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  location: string;
  teacher: string;
  weekParity: WeekParity;
};

const blankDraft = (dayOfWeek: number): Draft => ({
  id: null,
  subjectName: '',
  dayOfWeek,
  startTime: '08:00',
  endTime: '09:00',
  location: '',
  teacher: '',
  weekParity: 'every',
});

const toDraft = (entry: CurriculumEntry): Draft => ({
  id: entry.id,
  subjectName: entry.subjectName,
  dayOfWeek: entry.dayOfWeek,
  startTime: entry.startTime,
  endTime: entry.endTime,
  location: entry.location ?? '',
  teacher: entry.teacher ?? '',
  weekParity: entry.weekParity,
});

function minutesOf(time: string): number {
  const [hour, minute] = time.split(':');
  return Number(hour ?? 0) * 60 + Number(minute ?? 0);
}

export default function CurriculumScreen() {
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [draft, setDraft] = useState<Draft | null>(null);

  const entries = useCurriculumEntries(false);
  const weekStart = useSetting('weekStartsOn');
  // Two weeks: an odd/even slot only shows its true next instance beyond one.
  const upcoming = useUpcomingClasses({ days: 14 });

  const rows = entries.data ?? [];
  const active = rows.filter((row) => row.isActive);

  /** Soonest instance per subject — the same rule homework inference uses. */
  const nextBySubject = useMemo(() => {
    const map = new Map<string, number>();
    for (const occurrence of upcoming.data ?? []) {
      const key = occurrence.entry.subjectName.toLowerCase();
      const current = map.get(key);
      if (current === undefined || occurrence.startsAt < current) map.set(key, occurrence.startsAt);
    }
    return map;
  }, [upcoming.data]);

  const dayOrder = useMemo(
    () => (weekStart.value === 0 ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0]),
    [weekStart.value],
  );

  return (
    <Screen
      back
      title="Programme"
      subtitle={
        rows.length > 0
          ? `${countLabel(active.length, 'class', 'classes')} a week`
          : 'Your recurring week'
      }
      right={
        <Button
          icon="add"
          label="Add"
          size="sm"
          variant="primary"
          onPress={() => setDraft(blankDraft(dayOrder[0] ?? 1))}
        />
      }
    >
      {entries.isLoading && rows.length === 0 ? (
        <GridSkeleton />
      ) : entries.isError ? (
        <Card>
          <View style={styles.retry}>
            <Txt variant="caption" tone="danger" style={{ flex: 1 }}>
              Could not load the timetable.
            </Txt>
            <Button
              label="Retry"
              size="sm"
              variant="ghost"
              // See `centreOnRow`: `Button` pins itself to the top of a row.
              style={styles.centreOnRow}
              onPress={() => entries.refetch()}
            />
          </View>
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState
          icon="school-outline"
          title="No timetable yet"
          hint="Try: 'every Monday at 8 I have Physics, Tuesday at 10 Math'"
        />
      ) : (
        <>
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'grid', label: 'Week' },
              { value: 'list', label: 'List' },
            ]}
          />
          <ErrorBoundary label="programme">
            {view === 'grid' ? (
              <WeekGrid entries={active} dayOrder={dayOrder} onEdit={(e) => setDraft(toDraft(e))} />
            ) : (
              <WeekList
                entries={rows}
                dayOrder={dayOrder}
                nextBySubject={nextBySubject}
                onEdit={(e) => setDraft(toDraft(e))}
              />
            )}
          </ErrorBoundary>
        </>
      )}

      {draft ? (
        <EntrySheet draft={draft} onChange={setDraft} onClose={() => setDraft(null)} />
      ) : null}
    </Screen>
  );
}

/* -------------------------------------------------------------- week grid */

type Placed = { entry: CurriculumEntry; lane: number; lanes: number };

/**
 * Lane assignment for the blocks of one day: each block takes the first lane
 * that is already free at its start time. Two classes at the same hour are a
 * real thing in a timetable (a split group), and stacking them would hide one.
 */
function placeDay(entries: CurriculumEntry[]): Placed[] {
  const sorted = [...entries].sort((a, b) => minutesOf(a.startTime) - minutesOf(b.startTime));
  const laneEnds: number[] = [];
  const placed: { entry: CurriculumEntry; lane: number }[] = [];

  for (const entry of sorted) {
    const start = minutesOf(entry.startTime);
    const end = Math.max(minutesOf(entry.endTime), start + 15);
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    placed.push({ entry, lane });
  }
  return placed.map((p) => ({ ...p, lanes: Math.max(1, laneEnds.length) }));
}

function WeekGrid({
  entries,
  dayOrder,
  onEdit,
}: {
  entries: CurriculumEntry[];
  dayOrder: number[];
  onEdit: (entry: CurriculumEntry) => void;
}) {
  const { colors } = useTheme();
  // Column by column, left to right: `dayOrder` is Monday-first, so the week
  // fills in the direction it is read. Fading in place rather than rising — a
  // block's vertical position is the time it starts, and sliding it up from
  // below would draw every class at the wrong hour on the way in.
  const arrive = useStaggeredEntry();

  const { fromHour, toHour } = useMemo(() => {
    if (entries.length === 0) return { fromHour: 8, toHour: 16 };
    let min = 24;
    let max = 0;
    for (const entry of entries) {
      min = Math.min(min, Math.floor(minutesOf(entry.startTime) / 60));
      max = Math.max(max, Math.ceil(minutesOf(entry.endTime) / 60));
    }
    return { fromHour: Math.max(0, min), toHour: Math.min(24, Math.max(max, min + 2)) };
  }, [entries]);

  const hours = Array.from({ length: toHour - fromHour }, (_, i) => fromHour + i);
  const gridHeight = hours.length * HOUR_HEIGHT;
  const originMinutes = fromHour * 60;

  const byDay = useMemo(() => {
    const map = new Map<number, Placed[]>();
    for (const day of dayOrder) {
      map.set(day, placeDay(entries.filter((entry) => entry.dayOfWeek === day)));
    }
    return map;
  }, [entries, dayOrder]);

  return (
    <Card padded={false} style={{ paddingBottom: 6 }}>
      <View style={[styles.gridHeader, { borderBottomColor: colors.border }]}>
        <View style={{ width: GUTTER_WIDTH }} />
        {dayOrder.map((day) => {
          const count = byDay.get(day)?.length ?? 0;
          return (
            <View key={day} style={styles.gridHeaderCell}>
              <Txt variant="micro" tone={count > 0 ? 'secondary' : 'tertiary'}>
                {DAY_INITIAL[day]}
              </Txt>
            </View>
          );
        })}
      </View>

      <View style={{ flexDirection: 'row', height: gridHeight }}>
        <View style={{ width: GUTTER_WIDTH }}>
          {hours.map((hour) => (
            <View key={hour} style={{ height: HOUR_HEIGHT }}>
              <Txt variant="micro" tone="tertiary" style={{ marginTop: -6 }}>
                {String(hour).padStart(2, '0')}
              </Txt>
            </View>
          ))}
        </View>

        <View style={{ flex: 1, flexDirection: 'row' }}>
          {/* Hour rules sit behind every column so they read as one grid. */}
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            {hours.map((hour, index) => (
              <View
                key={hour}
                style={{
                  position: 'absolute',
                  top: index * HOUR_HEIGHT,
                  left: 0,
                  right: 0,
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: colors.border,
                }}
              />
            ))}
          </View>

          {dayOrder.map((day, column) => (
            <View key={day} style={{ flex: 1, paddingHorizontal: 1 }}>
              {(byDay.get(day) ?? []).map(({ entry, lane, lanes }) => {
                const start = minutesOf(entry.startTime);
                const end = Math.max(minutesOf(entry.endTime), start + 15);
                return (
                  // The block's *place* moved out to a wrapper so the entrance
                  // has a host view of its own, and so `TimetableBlock` is free
                  // to carry the press transform underneath it — two transforms
                  // on one view would mean the last one written wins. Same box,
                  // one view deeper; the pattern `DependencyGraph` uses.
                  //
                  // The whole column shares one step of the stagger: a day is
                  // what you read at a glance, not the individual lessons in
                  // it, and six lessons counting up inside one column would
                  // outrun the cap before the week was half drawn.
                  <Animated.View
                    key={entry.id}
                    entering={arrive(column)}
                    // Editing a class changes its hour or its lane; that is a
                    // move on the canvas, not a redraw.
                    layout={LinearTransition.duration(REFLOW_MS)}
                    style={[
                      styles.slot,
                      {
                        top: ((start - originMinutes) / 60) * HOUR_HEIGHT,
                        height: Math.max(MIN_BLOCK_HEIGHT, ((end - start) / 60) * HOUR_HEIGHT - 2),
                        left: `${(lane / lanes) * 100}%`,
                        width: `${100 / lanes}%`,
                      },
                    ]}
                  >
                    <TimetableBlock entry={entry} onPress={() => onEdit(entry)} />
                  </Animated.View>
                );
              })}
            </View>
          ))}
        </View>
      </View>
    </Card>
  );
}

/**
 * One class on the grid, extracted because each needs its own animation state
 * and a hook cannot be called from inside a `map`.
 *
 * The block is absolutely positioned by `top`/`left`/`height`/`width`, none of
 * which a transform touches — the scale happens around the block's own centre
 * and leaves it exactly where the timetable put it.
 */
function TimetableBlock({ entry, onPress }: { entry: CurriculumEntry; onPress: () => void }) {
  const { colors, radius, scheme } = useTheme();
  const press = usePressScale();
  const tint = entry.color ?? colorForTag(entry.subjectName, scheme);

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={`${entry.subjectName}, ${DAY_LONG[entry.dayOfWeek]} ${entry.startTime} to ${entry.endTime}`}
      onPress={onPress}
      {...press.handlers}
      style={[
        styles.block,
        {
          backgroundColor: colors.surfaceRaised,
          borderLeftColor: tint,
          borderRadius: radius.sm,
        },
        press.style,
      ]}
    >
      {/*
        One line, ellipsised, and it has to be — a week is seven columns across
        a phone, which is **45pt** each and 39 of that inside the block's rule
        and padding. Measured in Bricolage Medium: "Physics" is 41.9pt at
        `micro`'s 11 and 37.9 at 10, "Robotics" 47.7 and 42.7, "Chemistry"
        50.3, "Mathematics" 63.5. There is no size that fits them, so two lines
        did not wrap these names, it *broke* them: the grid read "Physic / s"
        and "Roboti / cs", an orphan letter on its own line under each class.
        A tail ellipsis leaves "Robotic…", which is the name; the full one is on
        the accessibility label above and on the List tab beside it.
      */}
      <Txt
        variant="micro"
        numberOfLines={1}
        ellipsizeMode="tail"
        style={{ color: tint, fontSize: 10, lineHeight: 13 }}
      >
        {entry.subjectName}
      </Txt>
    </AnimatedPressable>
  );
}

/* -------------------------------------------------------------- week list */

function WeekList({
  entries,
  dayOrder,
  nextBySubject,
  onEdit,
}: {
  entries: CurriculumEntry[];
  dayOrder: number[];
  nextBySubject: Map<string, number>;
  onEdit: (entry: CurriculumEntry) => void;
}) {
  const { spacing } = useTheme();
  const arrive = useStaggeredEntry({ from: 'below' });
  // One wave down the week rather than one per day: the days are a single
  // timetable broken by heading, and restarting the count at every heading
  // would make five short lists out of one.
  let rank = 0;

  return (
    <>
      {dayOrder.map((day) => {
        const rows = entries
          .filter((entry) => entry.dayOfWeek === day)
          .sort((a, b) => minutesOf(a.startTime) - minutesOf(b.startTime));
        if (rows.length === 0) return null;

        return (
          <Section key={day} title={DAY_LONG[day]} compact>
            <Card padded={false}>
              {rows.map((entry, index) => (
                <Animated.View
                  key={entry.id}
                  entering={arrive(rank++)}
                  // Deleting a class, or moving one to another day, takes a row
                  // out of the middle of the card.
                  layout={LinearTransition.duration(REFLOW_MS)}
                >
                  {index > 0 ? <Divider inset={spacing.md} /> : null}
                  <WeekRow
                    entry={entry}
                    nextAt={nextBySubject.get(entry.subjectName.toLowerCase())}
                    onPress={() => onEdit(entry)}
                  />
                </Animated.View>
              ))}
            </Card>
          </Section>
        );
      })}
    </>
  );
}

/**
 * One row of the week list, extracted for the same reason as `TimetableBlock`.
 */
function WeekRow({
  entry,
  nextAt,
  onPress,
}: {
  entry: CurriculumEntry;
  nextAt: number | undefined;
  onPress: () => void;
}) {
  const { colors, spacing, scheme } = useTheme();
  const press = usePressScale({ scale: 0.98 });
  const tint = entry.color ?? colorForTag(entry.subjectName, scheme);
  const meta = [entry.location, entry.teacher].filter(Boolean).join(' · ');

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={`Edit ${entry.subjectName}`}
      onPress={onPress}
      {...press.handlers}
      style={[styles.listRow, { paddingHorizontal: spacing.md }, press.style]}
    >
      <View style={{ width: 3, alignSelf: 'stretch', backgroundColor: tint, borderRadius: 2 }} />
      <Txt variant="mono" tone="secondary" style={{ width: 84 }}>
        {entry.startTime}–{entry.endTime}
      </Txt>
      <View style={{ flex: 1, gap: 1 }}>
        <Txt variant="bodyStrong" tone={entry.isActive ? 'primary' : 'tertiary'}>
          {entry.subjectName}
        </Txt>
        {meta ? (
          <Txt variant="caption" tone="tertiary" numberOfLines={1}>
            {meta}
          </Txt>
        ) : null}
        {entry.isActive && nextAt !== undefined ? (
          <Txt variant="micro" tone="tertiary">
            Next {formatDayHeading(nextAt)} at {formatTime(nextAt)}
          </Txt>
        ) : null}
      </View>
      {entry.weekParity !== 'every' ? (
        <Badge label={entry.weekParity.toUpperCase()} tone="info" />
      ) : null}
      {!entry.isActive ? <Badge label="OFF" tone="neutral" /> : null}
      <Ionicons name="chevron-forward" size={15} color={colors.textTertiary} />
    </AnimatedPressable>
  );
}

/* ------------------------------------------------------------ add / edit */

type Mode = 'form' | 'confirm';

function EntrySheet({
  draft,
  onChange,
  onClose,
}: {
  draft: Draft;
  onChange: (next: Draft) => void;
  onClose: () => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const add = useAddCurriculumEntries();
  const update = useUpdateCurriculumEntry();
  const remove = useDeleteCurriculumEntry();

  const [mode, setMode] = useState<Mode>('form');

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    onChange({ ...draft, [key]: value });

  const subjectError = draft.subjectName.trim() ? null : 'A class needs a subject.';
  const startError = TIME_OF_DAY_RE.test(draft.startTime) ? null : 'Use HH:mm, like 08:30.';
  const endError = !TIME_OF_DAY_RE.test(draft.endTime)
    ? 'Use HH:mm, like 09:15.'
    : minutesOf(draft.endTime) <= minutesOf(draft.startTime)
      ? 'The end has to be after the start.'
      : null;
  const invalid = Boolean(subjectError || startError || endError);
  const saving = add.isPending || update.isPending;

  const save = () => {
    if (invalid) return;
    const done = (message: string) => {
      toast.show({ message, tone: 'success' });
      onClose();
    };
    const failed = (error: Error) => toast.show({ message: error.message, tone: 'danger' });

    if (draft.id) {
      update.mutate(
        {
          id: draft.id,
          patch: {
            subjectName: draft.subjectName.trim(),
            dayOfWeek: draft.dayOfWeek,
            startTime: draft.startTime,
            endTime: draft.endTime,
            location: draft.location.trim() || null,
            teacher: draft.teacher.trim() || null,
            weekParity: draft.weekParity,
            // Nothing can switch a class off any more, so `false` is only ever
            // left over from the toggle that used to live here. The OFF badge
            // names the state; saving the row is the way back out of it.
            isActive: true,
          },
        },
        { onSuccess: () => done('Class updated'), onError: failed },
      );
      return;
    }

    add.mutate(
      [
        {
          subject_name: draft.subjectName.trim(),
          day_of_week: draft.dayOfWeek,
          start_time: draft.startTime,
          end_time: draft.endTime,
          location: draft.location.trim() || undefined,
          teacher: draft.teacher.trim() || undefined,
          week_parity: draft.weekParity,
        },
      ],
      { onSuccess: () => done('Class added'), onError: failed },
    );
  };

  const confirmDelete = () =>
    remove.mutate(draft.id!, {
      onSuccess: () => {
        toast.show({ message: 'Class removed', tone: 'neutral' });
        onClose();
      },
      onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
    });

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={[styles.backdrop, { backgroundColor: colors.overlay }]}
        onPress={onClose}
      />
      {/* A Modal is its own window on Android, so the activity's adjustResize
          never reaches it and the keyboard covered the fields it opened for. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.sheetWrap}
      >
        <SheetCard
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
            },
          ]}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              padding: spacing.lg,
              // Save and Delete sit at the bottom, under the home indicator otherwise.
              paddingBottom: insets.bottom + spacing.lg,
              gap: spacing.md,
            }}
          >
            <View style={styles.sheetHead}>
              <Txt variant="heading">{draft.id ? 'Edit class' : 'New class'}</Txt>
              <Button
                icon="close"
                size="sm"
                variant="ghost"
                accessibilityLabel="Close"
                onPress={onClose}
              />
            </View>

            <Input
              label="Subject"
              value={draft.subjectName}
              onChangeText={(text) => set('subjectName', text)}
              placeholder="Physics"
              autoFocus={!draft.id}
              error={draft.subjectName.length > 0 ? (subjectError ?? undefined) : undefined}
            />

            <View style={{ gap: spacing.sm }}>
              <Txt variant="micro" tone="tertiary" style={{ letterSpacing: 0.6 }}>
                DAY
              </Txt>
              <View style={styles.chips}>
                {DAY_SHORT.map((label, day) => (
                  <Chip
                    key={label + day}
                    label={label}
                    selected={draft.dayOfWeek === day}
                    onPress={() => set('dayOfWeek', day)}
                  />
                ))}
              </View>
            </View>

            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <Input
                label="Starts"
                containerStyle={{ flex: 1 }}
                value={draft.startTime}
                onChangeText={(text) => set('startTime', text)}
                placeholder="08:00"
                keyboardType="numbers-and-punctuation"
                error={startError ?? undefined}
              />
              <Input
                label="Ends"
                containerStyle={{ flex: 1 }}
                value={draft.endTime}
                onChangeText={(text) => set('endTime', text)}
                placeholder="09:00"
                keyboardType="numbers-and-punctuation"
                error={endError ?? undefined}
              />
            </View>

            <Input
              label="Location"
              value={draft.location}
              onChangeText={(text) => set('location', text)}
              placeholder="Room 204"
            />
            <Input
              label="Teacher"
              value={draft.teacher}
              onChangeText={(text) => set('teacher', text)}
              placeholder="Mrs Petrova"
            />

            <View style={{ gap: spacing.sm }}>
              <Txt variant="micro" tone="tertiary" style={{ letterSpacing: 0.6 }}>
                REPEATS
              </Txt>
              <Segmented
                value={draft.weekParity}
                onChange={(value) => set('weekParity', value)}
                options={[
                  { value: 'every' as WeekParity, label: 'Every' },
                  { value: 'odd' as WeekParity, label: 'Odd' },
                  { value: 'even' as WeekParity, label: 'Even' },
                ]}
              />
              <Txt variant="micro" tone="tertiary">
                {PARITY_LABEL[draft.weekParity]} — parity follows the ISO week number.
              </Txt>
            </View>

            {mode === 'confirm' ? (
              <View style={{ gap: spacing.sm }}>
                <Txt variant="caption" tone="secondary">
                  Delete “{draft.subjectName.trim() || 'this class'}”? It goes from every week.
                </Txt>
                <View style={styles.chips}>
                  <Button
                    label="Delete"
                    variant="danger"
                    loading={remove.isPending}
                    onPress={confirmDelete}
                  />
                  <Button label="Keep" variant="ghost" onPress={() => setMode('form')} />
                </View>
              </View>
            ) : (
              <View style={styles.chips}>
                <Button
                  label={draft.id ? 'Save' : 'Add class'}
                  variant="primary"
                  disabled={invalid}
                  loading={saving}
                  onPress={save}
                />
                {draft.id ? (
                  <Button label="Delete" variant="danger" onPress={() => setMode('confirm')} />
                ) : null}
              </View>
            )}
          </ScrollView>
        </SheetCard>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/* ---------------------------------------------------------------- loading */

function GridSkeleton() {
  const { colors, radius, spacing } = useTheme();
  return (
    <Card padded={false} style={{ padding: spacing.md, gap: spacing.sm }}>
      {Array.from({ length: 6 }, (_, index) => (
        <View
          key={index}
          style={{
            height: 22,
            width: `${90 - index * 8}%`,
            borderRadius: radius.sm,
            backgroundColor: colors.surfaceSunken,
          }}
        />
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  /**
   * `Button` sets `alignSelf: 'flex-start'` so it does not stretch to the
   * full width of a *column*. On a row that same declaration means the top,
   * and it beats the row's own `alignItems`. Only the caller knows which axis
   * it is on, so the caller says.
   */
  centreOnRow: { alignSelf: 'center' },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  gridHeader: {
    flexDirection: 'row',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  gridHeaderCell: { flex: 1, alignItems: 'center' },
  /** The block's place on the grid; the block itself fills it. */
  slot: { position: 'absolute' },
  block: {
    flex: 1,
    borderLeftWidth: 2,
    // 2 rather than 3: at a 45pt column every point of it is a character.
    paddingHorizontal: 2,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    minHeight: 46,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '88%',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
