import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { epochToLocal } from '@/core/time';
import { invalidateKeys, qk, useLogHabit, type TodayHabit } from '@/hooks';
import { useTheme } from '@/ui/ThemeProvider';
import { Chip, useToast } from '@/ui/components';

type Pending = { streak: number };

/**
 * One tap per habit, in one line.
 *
 * Streaks are the only place in the app where *not* acting has a cost, so the
 * strip has to be readable in the second it takes to walk past it: filled means
 * logged, amber means the run ends tonight, and the number is the streak the
 * tap is protecting. The optimistic streak is local rather than a cache patch —
 * the real number comes back from the write, and guessing it into the shared
 * snapshot would be a lie the next screen repeats.
 */
export function HabitStrip({ habits, at, zone }: { habits: readonly TodayHabit[]; at: number; zone: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const { colors, spacing } = useTheme();
  const log = useLogHabit();
  const [pending, setPending] = useState<Record<string, Pending>>({});

  // `lastCompletedDate` is the newest logged day, so "yesterday" is exactly
  // "logged yesterday and not today" — one quiet day and the run is gone.
  const yesterday = epochToLocal(at, zone).minus({ days: 1 }).toISODate();

  const onLog = useCallback(
    (entry: TodayHabit) => {
      const { habit, streak } = entry;
      setPending((prev) => ({ ...prev, [habit.id]: { streak: streak + 1 } }));
      log.mutate(
        { habitName: habit.name },
        {
          // The streak line in the briefing card above is composed from this
          // very streak; leaving it saying "ends tonight" after the tap that
          // saved it is the screen arguing with itself.
          onSettled: () => void invalidateKeys(client, [qk.briefing.all]),
          onSuccess: (result) => {
            setPending((prev) => ({ ...prev, [habit.id]: { streak: result.streak } }));
            toast.show({
              message: `${habit.name} logged`,
              detail: `${result.streak}-day streak`,
              tone: 'success',
            });
          },
          onError: (error) => {
            setPending((prev) => {
              const next = { ...prev };
              delete next[habit.id];
              return next;
            });
            toast.show({ message: `Could not log ${habit.name}`, detail: error.message, tone: 'danger' });
          },
        },
      );
    },
    [client, log, toast],
  );

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.strip, { gap: spacing.sm }]}
    >
      {habits.map((entry) => {
        const optimistic = pending[entry.habit.id];
        const logged = entry.loggedToday || optimistic !== undefined;
        const streak = optimistic?.streak ?? entry.streak;
        const atRisk =
          !logged && yesterday != null && entry.habit.lastCompletedDate === yesterday;

        return (
          <Pressable
            key={entry.habit.id}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: logged, disabled: logged }}
            accessibilityLabel={
              logged
                ? `${entry.habit.name}, logged today, ${streak}-day streak`
                : `Log ${entry.habit.name}${atRisk ? ', streak at risk' : ''}`
            }
            disabled={logged}
            // The chip itself is 26pt tall; the slop is what makes it tappable
            // while walking.
            hitSlop={{ top: 11, bottom: 11, left: 4, right: 4 }}
            onPress={() => onLog(entry)}
            style={({ pressed }) => [styles.slot, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Chip
              label={streak > 0 ? `${entry.habit.name} ${streak}` : entry.habit.name}
              icon={logged ? 'checkmark' : atRisk ? 'flame' : 'ellipse-outline'}
              selected={logged}
              color={logged ? colors.success : atRisk ? colors.warning : colors.textSecondary}
            />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  strip: { paddingVertical: 4, paddingRight: 4 },
  slot: { justifyContent: 'center' },
});
