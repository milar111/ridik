import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { useQueryClient } from '@tanstack/react-query';

import { epochToLocal } from '@/core/time';
import { invalidateKeys, qk, useLogHabit, type TodayHabit } from '@/hooks';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, useCheckPop, usePressScale , useStaggeredEntry } from '@/ui/motionHooks';
import { Chip, useToast } from '@/ui/components';
import { REFLOW_MS } from '@/ui/motion';

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
  // A row, not a column: these arrive by fading in place. Sliding a horizontal
  // strip up from below would have every chip cross the agenda row under it.
  const arrive = useStaggeredEntry();

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
      {habits.map((entry, index) => {
        const optimistic = pending[entry.habit.id];
        const logged = entry.loggedToday || optimistic !== undefined;
        const streak = optimistic?.streak ?? entry.streak;
        const atRisk =
          !logged && yesterday != null && entry.habit.lastCompletedDate === yesterday;

        return (
          // Wrapped rather than animated in place: `Slot` owns the press
          // transform, and a second transform on the same view would mean the
          // last one written wins. `layout` covers a habit dropping out of the
          // strip once it is logged.
          <Animated.View
            key={entry.habit.id}
            entering={arrive(index)}
            layout={LinearTransition.duration(REFLOW_MS)}
          >
            <Slot
              name={entry.habit.name}
              label={streak > 0 ? `${entry.habit.name} ${streak}` : entry.habit.name}
              logged={logged}
              atRisk={atRisk}
              streak={streak}
              tint={logged ? colors.success : atRisk ? colors.warning : colors.textSecondary}
              onPress={() => onLog(entry)}
            />
          </Animated.View>
        );
      })}
    </ScrollView>
  );
}

/**
 * One habit, extracted because each needs its own animation state and a hook
 * cannot be called from inside a `map`.
 *
 * The pop is the point. Logging a habit is one of the two things this app asks
 * of you every day, and it used to change the icon, the colour and the streak
 * number in a single frame with nothing to mark that the tap had landed — the
 * app's biggest reward moment, delivered as a re-render. `useCheckPop` is silent
 * on mount, so a strip of habits already done today does not all jump when the
 * screen opens.
 */
function Slot({
  name,
  label,
  logged,
  atRisk,
  streak,
  tint,
  onPress,
}: {
  name: string;
  label: string;
  logged: boolean;
  atRisk: boolean;
  streak: number;
  tint: string;
  onPress: () => void;
}) {
  // `disabled` stops the press answering once the habit is logged, which is
  // also when the Pressable itself stops taking touches.
  const press = usePressScale({ disabled: logged });
  const pop = useCheckPop(logged);
  return (
    <AnimatedPressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: logged, disabled: logged }}
      accessibilityLabel={
        logged ? `${name}, logged today, ${streak}-day streak` : `Log ${name}${atRisk ? ', streak at risk' : ''}`
      }
      disabled={logged}
      // The chip itself is 26pt tall; the slop is what makes it tappable
      // while walking. Slop measures the layout box, which a scale leaves alone.
      hitSlop={{ top: 11, bottom: 11, left: 4, right: 4 }}
      onPress={onPress}
      {...press.handlers}
      style={[styles.slot, press.style]}
    >
      <Animated.View style={pop}>
        <Chip
          label={label}
          icon={logged ? 'checkmark' : atRisk ? 'flame' : 'ellipse-outline'}
          selected={logged}
          color={tint}
        />
      </Animated.View>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  strip: { paddingVertical: 4, paddingRight: 4 },
  slot: { justifyContent: 'center' },
});
