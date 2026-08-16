/**
 * The empty half of the receipt: what you could say, drawn from what you have.
 *
 * `LastAction` renders nothing until something has been said, which is every
 * cold start and every launch of a fresh install — so the one screen in the app
 * spent its first impression explaining nothing. This is what stands there
 * instead, and it is deliberately not a tour: three lines, no steps, no
 * dismissal to remember, gone the moment there is a real receipt to show.
 *
 * The lines are the user's own where they can be. `buildExamples` holds that
 * arithmetic; this file is the two queries that feed it and the timer that
 * turns the pool over. Both queries are cheap list-of-names reads that Today
 * has usually warmed already, and neither is required — with nothing to draw
 * on, the pool falls back to plain sentences rather than disappearing.
 */
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';

import { useTheme } from '@/ui/ThemeProvider';
import { Txt } from '@/ui/components/Text';
import { useChecklistNames, useHabits } from '@/hooks';
import { useVoiceStore } from '@/features/voice/store';
import { buildExamples, exampleWindow, EXAMPLE_ROTATE_MS } from './examples';

export function HomeExamples() {
  const { spacing } = useTheme();
  const reduced = useReducedMotion();
  const status = useVoiceStore((s) => s.status);
  const lists = useChecklistNames();
  const habits = useHabits();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), EXAMPLE_ROTATE_MS);
    return () => clearInterval(id);
  }, []);

  const pool = useMemo(
    () =>
      buildExamples({
        lists: (lists.data ?? []).map((list) => list.name),
        habits: (habits.data ?? []).map((habit) => habit.name),
      }),
    [lists.data, habits.data],
  );

  // Nothing to suggest while a session is live: the caption under the mic is
  // already the transcript, and a second column of sentences to read beside it
  // is the opposite of what somebody mid-utterance needs. Below the hooks, so
  // the order cannot change with the status.
  if (status !== 'idle') return null;

  const shown = exampleWindow(pool, tick);
  if (shown.length === 0) return null;

  return (
    <View style={{ gap: 6, paddingHorizontal: spacing.sm }}>
      {/* Says the thing nothing else in the app says: this takes questions.
          Full width, because a tracked label sized to its own content is
          measured short on Android and ellipsised — "SAY OR AS…". */}
      <Txt variant="eyebrow" tone="tertiary" style={{ width: '100%' }}>
        SAY OR ASK
      </Txt>
      <Animated.View
        // Keyed on the tick so a rotation is a new view and gets the entrance:
        // three lines swapping in place with no fade reads as a redraw glitch.
        key={tick}
        entering={reduced ? undefined : FadeIn.duration(320)}
        style={{ gap: 3 }}
      >
        {shown.map((line) => (
          <Txt key={line} variant="caption" tone="secondary" numberOfLines={1}>
            {`“${line}”`}
          </Txt>
        ))}
      </Animated.View>
    </View>
  );
}
