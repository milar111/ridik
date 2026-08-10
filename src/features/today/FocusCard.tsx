import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { formatClock, formatDuration } from '@/core/time';
import { useFocusControl, useLiveFocus } from '@/hooks/useFocusRuntime';
import { useTheme } from '@/ui/ThemeProvider';
import { Button, Card, Txt, useToast } from '@/ui/components';

/**
 * The running timer, on the screen the user is already looking at.
 *
 * The countdown comes off the runtime's snapshot rather than a local
 * `setInterval`: the same numbers drive the lock screen and the phase-change
 * alarms, and two clocks that disagree by a second are worse than one clock.
 * The controls go through the runtime for the same reason — writing the row
 * directly would leave the notifications scheduled against a phase that has
 * already ended.
 *
 * Only the title row navigates. A card that is itself a link while carrying
 * three buttons is a card you leave by accident.
 */
export function FocusCard() {
  const router = useRouter();
  const toast = useToast();
  const { colors, radius, spacing } = useTheme();
  const { snapshot, phases } = useLiveFocus();
  const control = useFocusControl();

  if (!snapshot || snapshot.isComplete) return null;

  const paused = snapshot.status === 'paused';
  const total = snapshot.phaseElapsedMs + snapshot.phaseRemainingMs;
  const progress = total > 0 ? Math.min(1, snapshot.phaseElapsedMs / total) : 0;
  const isBreak = snapshot.phase.kind === 'break';
  const tint = isBreak ? colors.success : colors.accent;
  const phaseCount = Math.max(snapshot.phaseCount, phases.length);

  const run = (action: 'pause' | 'resume' | 'skip' | 'stop') => {
    control.mutate(action, {
      onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
    });
  };

  return (
    <Card accent={tint} style={{ gap: spacing.sm }} testID="today-focus">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${isBreak ? 'Break' : snapshot.label} — open the focus screen`}
        onPress={() => router.push('/focus')}
        style={({ pressed }) => [styles.head, { opacity: pressed ? 0.7 : 1 }]}
      >
        <View style={{ flex: 1, gap: 1 }}>
          <Txt variant="bodyStrong" numberOfLines={1}>
            {isBreak ? 'Break' : snapshot.label}
          </Txt>
          <Txt variant="micro" tone={paused ? 'warning' : 'tertiary'}>
            {`Phase ${snapshot.phaseIndex + 1} of ${phaseCount} · ${formatDuration(snapshot.phase.minutes)}${paused ? ' · paused' : ''}`}
          </Txt>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
      </Pressable>

      <Txt
        variant="timer"
        accessibilityLabel={`${formatClock(snapshot.phaseRemainingMs)} left`}
        style={{ color: paused ? colors.textSecondary : tint }}
      >
        {snapshot.clock}
      </Txt>

      <View
        accessibilityRole="progressbar"
        accessibilityValue={{ now: Math.round(progress * 100), min: 0, max: 100 }}
        style={[styles.track, { backgroundColor: colors.surfaceSunken, borderRadius: radius.pill }]}
      >
        <View
          style={[
            styles.fill,
            {
              width: `${progress * 100}%`,
              backgroundColor: paused ? colors.textTertiary : tint,
              borderRadius: radius.pill,
            },
          ]}
        />
      </View>

      <View style={[styles.controls, { gap: spacing.sm }]}>
        <Button
          label={paused ? 'Resume' : 'Pause'}
          icon={paused ? 'play' : 'pause'}
          size="sm"
          style={styles.control}
          onPress={() => run(paused ? 'resume' : 'pause')}
        />
        <Button
          label="Skip"
          icon="play-forward"
          size="sm"
          style={styles.control}
          // Nothing to skip to on the last phase; stopping is the honest verb.
          disabled={snapshot.phaseIndex >= phaseCount - 1}
          onPress={() => run('skip')}
        />
        <Button
          label="Stop"
          icon="stop"
          size="sm"
          variant="danger"
          style={styles.control}
          onPress={() => run('stop')}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  track: { height: 3, overflow: 'hidden' },
  fill: { height: 3 },
  controls: { flexDirection: 'row', alignItems: 'center' },
  // A `sm` button is 31pt tall. These three are pressed one-handed, walking.
  control: { minHeight: 44 },
});
