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
import { Modal, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
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
  isActive: boolean;
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
  isActive: true,
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
  isActive: entry.isActive,
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
            <Button label="Retry" size="sm" variant="ghost" onPress={() => entries.refetch()} />
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

      {draft ? <EntrySheet draft={draft} onChange={setDraft} onClose={() => setDraft(null)} /> : null}
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
  const { colors, radius } = useTheme();

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
      map.set(
        day,
        placeDay(entries.filter((entry) => entry.dayOfWeek === day)),
      );
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

          {dayOrder.map((day) => (
            <View key={day} style={{ flex: 1, paddingHorizontal: 1 }}>
              {(byDay.get(day) ?? []).map(({ entry, lane, lanes }) => {
                const start = minutesOf(entry.startTime);
                const end = Math.max(minutesOf(entry.endTime), start + 15);
                const tint = entry.color ?? colorForTag(entry.subjectName);
                return (
                  <Pressable
                    key={entry.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${entry.subjectName}, ${DAY_LONG[entry.dayOfWeek]} ${entry.startTime} to ${entry.endTime}`}
                    onPress={() => onEdit(entry)}
                    style={({ pressed }) => [
                      styles.block,
                      {
                        top: ((start - originMinutes) / 60) * HOUR_HEIGHT,
                        height: Math.max(MIN_BLOCK_HEIGHT, ((end - start) / 60) * HOUR_HEIGHT - 2),
                        left: `${(lane / lanes) * 100}%`,
                        width: `${100 / lanes}%`,
                        backgroundColor: colors.surfaceRaised,
                        borderLeftColor: tint,
                        borderRadius: radius.sm,
                        opacity: pressed ? 0.6 : 1,
                      },
                    ]}
                  >
                    <Txt variant="micro" numberOfLines={2} style={{ color: tint }}>
                      {entry.subjectName}
                    </Txt>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      </View>
    </Card>
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
  const { colors, spacing } = useTheme();

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
              {rows.map((entry, index) => {
                const tint = entry.color ?? colorForTag(entry.subjectName);
                const meta = [entry.location, entry.teacher].filter(Boolean).join(' · ');
                const nextAt = nextBySubject.get(entry.subjectName.toLowerCase());
                return (
                  <View key={entry.id}>
                    {index > 0 ? <Divider inset={spacing.md} /> : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Edit ${entry.subjectName}`}
                      onPress={() => onEdit(entry)}
                      style={({ pressed }) => [
                        styles.listRow,
                        { paddingHorizontal: spacing.md, opacity: pressed ? 0.6 : 1 },
                      ]}
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
                    </Pressable>
                  </View>
                );
              })}
            </Card>
          </Section>
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------ add / edit */

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

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => onChange({ ...draft, [key]: value });

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
            isActive: draft.isActive,
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
          is_active: draft.isActive,
        },
      ],
      { onSuccess: () => done('Class added'), onError: failed },
    );
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={[styles.backdrop, { backgroundColor: colors.overlay }]}
        onPress={onClose}
      />
      <View
        style={[
          styles.sheet,
          { backgroundColor: colors.surface, borderColor: colors.border, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl },
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
            <Button icon="close" size="sm" variant="ghost" accessibilityLabel="Close" onPress={onClose} />
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

          <View style={styles.switchRow}>
            <View style={{ flex: 1, gap: 1 }}>
              <Txt variant="body">Active</Txt>
              <Txt variant="micro" tone="tertiary">
                Switched off, it stays here but never counts towards a due date.
              </Txt>
            </View>
            <Switch
              value={draft.isActive}
              onValueChange={(value) => set('isActive', value)}
              accessibilityLabel="Active"
              accessibilityState={{ checked: draft.isActive }}
              trackColor={{ false: colors.borderStrong, true: colors.accent }}
              thumbColor="#FFFFFF"
            />
          </View>

          <View style={styles.chips}>
            <Button
              label={draft.id ? 'Save' : 'Add class'}
              variant="primary"
              disabled={invalid}
              loading={saving}
              onPress={save}
            />
            {draft.id ? (
              <Button
                label="Delete"
                variant="danger"
                loading={remove.isPending}
                onPress={() =>
                  remove.mutate(draft.id!, {
                    onSuccess: () => {
                      toast.show({ message: 'Class removed', tone: 'neutral' });
                      onClose();
                    },
                    onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
                  })
                }
              />
            ) : null}
          </View>
        </ScrollView>
      </View>
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
  retry: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  gridHeader: {
    flexDirection: 'row',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  gridHeaderCell: { flex: 1, alignItems: 'center' },
  block: {
    position: 'absolute',
    borderLeftWidth: 2,
    paddingHorizontal: 3,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, minHeight: 46 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
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
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
});
