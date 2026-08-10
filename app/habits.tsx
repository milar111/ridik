import { useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { countLabel } from '@/core/format';
import { toAppError } from '@/core/result';
import { currentZone, epochToLocal, todayLocalDate, type LocalDate } from '@/core/time';
import type { Habit } from '@/db/schema';
import {
  useArchiveHabit,
  useCreateHabit,
  useDeleteHabit,
  useHabitHistory,
  useHabits,
  useLogHabit,
} from '@/hooks';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Screen,
  Section,
  Segmented,
  Txt,
  useToast,
} from '@/ui/components';

type Unit = Habit['unit'];

const UNITS: { value: Unit; label: string }[] = [
  { value: 'session', label: 'Session' },
  { value: 'minutes', label: 'Minutes' },
  { value: 'count', label: 'Count' },
];

/** Five weeks of seven days is the widest grid that still fits beside the name. */
const WEEKS = 5;
const CELL = 13;
const CELL_GAP = 3;

const WEEKDAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function reason(error: unknown): string {
  return toAppError(error).userMessage;
}

export default function HabitsScreen() {
  const [adding, setAdding] = useState(false);

  return (
    <Screen
      title="Habits"
      right={
        <Button
          icon={adding ? 'close' : 'add'}
          size="sm"
          accessibilityLabel={adding ? 'Cancel new habit' : 'Add a habit'}
          onPress={() => setAdding((open) => !open)}
        />
      }
    >
      {adding ? <AddHabitCard onDone={() => setAdding(false)} /> : null}
      <ErrorBoundary label="habits">
        <HabitList />
      </ErrorBoundary>
    </Screen>
  );
}

function HabitList() {
  const { spacing } = useTheme();
  const habits = useHabits();

  const zone = currentZone();
  // Resolved once per mount: a screen left open across midnight is rarer than
  // the re-render churn recomputing these on every frame would cost.
  const calendar = useMemo(() => {
    const nowLocal = epochToLocal(Date.now(), zone);
    const start = nowLocal.startOf('week').minus({ weeks: WEEKS - 1 });
    return {
      today: todayLocalDate(zone),
      yesterday: nowLocal.minus({ days: 1 }).toISODate()!,
      gridStart: start.toISODate()!,
      days: Array.from({ length: WEEKS * 7 }, (_, i) => start.plus({ days: i }).toISODate()!),
    };
  }, [zone]);

  const ordered = useMemo(() => {
    const rows = habits.data ?? [];
    const atRisk = (habit: Habit) => habit.lastCompletedDate === calendar.yesterday;
    // Stable sort: the repository already returns them name-ordered, so this
    // only lifts the ones about to break their streak.
    return [...rows].sort((a, b) => Number(atRisk(b)) - Number(atRisk(a)));
  }, [habits.data, calendar.yesterday]);

  if (habits.isError) {
    return <RetryRow message={reason(habits.error)} onRetry={() => void habits.refetch()} />;
  }

  if (habits.isPending) return <SkeletonCards />;

  if (ordered.length === 0) {
    return (
      <EmptyState
        icon="flame-outline"
        title="No habits tracked yet"
        hint="Try: 'logged 45 minutes of workout'"
      />
    );
  }

  return (
    <View style={{ gap: spacing.sm }}>
      {ordered.map((habit) => (
        <HabitCard
          key={habit.id}
          habit={habit}
          today={calendar.today}
          yesterday={calendar.yesterday}
          gridStart={calendar.gridStart}
          days={calendar.days}
        />
      ))}
    </View>
  );
}

function HabitCard({
  habit,
  today,
  yesterday,
  gridStart,
  days,
}: {
  habit: Habit;
  today: LocalDate;
  yesterday: LocalDate;
  gridStart: LocalDate;
  days: readonly LocalDate[];
}) {
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const history = useHabitHistory(habit.id, { from: gridStart, to: today });
  const log = useLogHabit();
  const archive = useArchiveHabit();
  const remove = useDeleteHabit();

  // Optimism lives here rather than in the cache: the streak the repository
  // returns depends on history this screen does not own, so the card shows the
  // one honest guess — today is done — until the real number lands.
  const [pending, setPending] = useState(false);

  const last = habit.lastCompletedDate;
  const loggedToday = last === today || pending;
  const atRisk = !loggedToday && last === yesterday;
  // The same arithmetic `advanceStreak` does, so the optimistic number is the
  // one the write is about to produce rather than always "one more".
  const streak =
    !pending || last === today
      ? (habit.currentStreak ?? 0)
      : last === yesterday
        ? (habit.currentStreak ?? 0) + 1
        : 1;

  const logged = useMemo(() => new Set(history.data ?? []), [history.data]);

  const onLog = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setPending(true);
    log.mutate(
      { habitName: habit.name },
      {
        onSuccess: (result) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          toast.show({
            message: result.streakChanged
              ? `${habit.name} · ${countLabel(result.streak, 'day')} streak`
              : `${habit.name} logged again today`,
            tone: 'success',
          });
        },
        onError: (error) =>
          toast.show({ message: 'Could not log that', detail: reason(error), tone: 'danger' }),
        onSettled: () => setPending(false),
      },
    );
  };

  const onMenu = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    Alert.alert(habit.name, `${countLabel(habit.longestStreak, 'day')} at best`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Archive',
        onPress: () =>
          archive.mutate(
            { habitId: habit.id, archived: true },
            {
              onSuccess: () => toast.show({ message: `${habit.name} archived` }),
              onError: (error) =>
                toast.show({ message: 'Could not archive that', detail: reason(error), tone: 'danger' }),
            },
          ),
      },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          remove.mutate(habit.id, {
            onSuccess: () => toast.show({ message: `${habit.name} deleted`, tone: 'warning' }),
            onError: (error) =>
              toast.show({ message: 'Could not delete that', detail: reason(error), tone: 'danger' }),
          }),
      },
    ]);
  };

  const meta = [
    habit.longestStreak > 0 ? `best ${habit.longestStreak}` : null,
    habit.unit,
    habit.targetPerWeek ? `${habit.targetPerWeek}×/week` : null,
  ].filter((part): part is string => part !== null);

  return (
    <Card
      accent={atRisk ? colors.warning : undefined}
      style={atRisk ? { backgroundColor: colors.warningMuted } : undefined}
      onPress={onLog}
      onLongPress={onMenu}
    >
      <View
        // The whole card is the log button; the grid inside it is a read-only
        // record, so one label describes the pair.
        accessibilityLabel={`${habit.name}, ${countLabel(streak, 'day')} streak${
          loggedToday ? ', logged today' : atRisk ? ', at risk today' : ''
        }`}
        accessibilityHint="Long press for archive and delete"
        style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}
      >
        <View style={{ flex: 1, gap: 4 }}>
          <View style={styles.titleRow}>
            <Ionicons
              name="flame"
              size={16}
              color={streak > 0 ? colors.warning : colors.textTertiary}
            />
            <Txt variant="heading">{streak}</Txt>
            <Txt variant="bodyStrong" numberOfLines={1} style={{ flex: 1 }}>
              {habit.name}
            </Txt>
            {loggedToday ? (
              <Ionicons name="checkmark-circle" size={19} color={colors.success} />
            ) : null}
          </View>

          <Txt variant="micro" tone="tertiary">
            {meta.join(' · ')}
          </Txt>

          {atRisk ? (
            <View style={[styles.titleRow, { marginTop: 2 }]}>
              <Badge label="AT RISK" tone="warning" />
              <Txt variant="micro" tone="warning">
                tap to keep the streak
              </Txt>
            </View>
          ) : null}
        </View>

        <ContributionGrid
          days={days}
          logged={logged}
          today={today}
          pending={pending}
          loading={history.isPending}
        />
      </View>
    </Card>
  );
}

function ContributionGrid({
  days,
  logged,
  today,
  pending,
  loading,
}: {
  days: readonly LocalDate[];
  logged: ReadonlySet<LocalDate>;
  today: LocalDate;
  pending: boolean;
  loading: boolean;
}) {
  const { colors } = useTheme();
  const hits = days.filter((day) => logged.has(day) || (pending && day === today)).length;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${hits} of the last ${days.length} days logged`}
      style={{ gap: CELL_GAP, opacity: loading ? 0.4 : 1 }}
    >
      <View style={styles.gridRow}>
        {WEEKDAY_LETTERS.map((letter, i) => (
          <Txt key={i} variant="micro" tone="tertiary" style={styles.weekdayLetter}>
            {letter}
          </Txt>
        ))}
      </View>
      {Array.from({ length: WEEKS }, (_, week) => (
        <View key={week} style={styles.gridRow}>
          {days.slice(week * 7, week * 7 + 7).map((day) => {
            const isToday = day === today;
            const done = logged.has(day) || (pending && isToday);
            const future = day > today;
            return (
              <View
                key={day}
                style={[
                  styles.cell,
                  {
                    backgroundColor: done
                      ? colors.success
                      : future
                        ? 'transparent'
                        : colors.surfaceSunken,
                    borderColor: isToday ? colors.accent : colors.border,
                    borderWidth: isToday ? 1.5 : StyleSheet.hairlineWidth,
                  },
                ]}
              />
            );
          })}
        </View>
      ))}
    </View>
  );
}

function AddHabitCard({ onDone }: { onDone: () => void }) {
  const { spacing } = useTheme();
  const toast = useToast();
  const create = useCreateHabit();
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<Unit>('session');

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.show({ message: 'A habit needs a name', tone: 'danger' });
      return;
    }
    create.mutate(
      { name: trimmed, options: { unit } },
      {
        onSuccess: (habit) => {
          toast.show({ message: `Tracking ${habit.name}`, tone: 'success' });
          setName('');
          onDone();
        },
        onError: (error) =>
          toast.show({ message: 'Could not add that', detail: reason(error), tone: 'danger' }),
      },
    );
  };

  return (
    <Section title="New habit">
      <Card style={{ gap: spacing.md }}>
        <Input
          label="Name"
          value={name}
          onChangeText={setName}
          placeholder="Workout"
          autoFocus
          returnKeyType="done"
          onSubmitEditing={submit}
        />
        <View style={{ gap: 4 }}>
          <Txt variant="micro" tone="tertiary" style={{ letterSpacing: 0.6 }}>
            UNIT
          </Txt>
          <Segmented options={UNITS} value={unit} onChange={setUnit} />
        </View>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Button
            label="Start tracking"
            variant="primary"
            onPress={submit}
            loading={create.isPending}
            style={{ flex: 1 }}
          />
          <Button label="Cancel" variant="ghost" onPress={onDone} />
        </View>
      </Card>
    </Section>
  );
}

function RetryRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { colors, spacing } = useTheme();
  return (
    <Card style={{ borderColor: colors.danger }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <Txt variant="caption" tone="danger" style={{ flex: 1 }}>
          {message}
        </Txt>
        <Button label="Retry" size="sm" onPress={onRetry} />
      </View>
    </Card>
  );
}

function SkeletonCards({ count = 3 }: { count?: number }) {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ gap: spacing.sm }}>
      {Array.from({ length: count }, (_, i) => (
        <Card key={i}>
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <View style={{ flex: 1, gap: 8 }}>
              <View
                style={[
                  styles.bone,
                  { width: `${62 - i * 8}%`, height: 13, backgroundColor: colors.surfaceRaised },
                ]}
              />
              <View
                style={[
                  styles.bone,
                  { width: '38%', height: 8, backgroundColor: colors.surfaceSunken },
                ]}
              />
            </View>
            <View
              style={[
                styles.bone,
                {
                  width: 7 * CELL + 6 * CELL_GAP,
                  height: WEEKS * CELL + (WEEKS - 1) * CELL_GAP,
                  backgroundColor: colors.surfaceSunken,
                },
              ]}
            />
          </View>
        </Card>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  gridRow: { flexDirection: 'row', gap: CELL_GAP },
  weekdayLetter: { width: CELL, textAlign: 'center' },
  cell: { width: CELL, height: CELL, borderRadius: 3 },
  bone: { borderRadius: 4 },
});
