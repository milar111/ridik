import { useMemo, useState } from 'react';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { formatClock, formatDayHeading, formatDuration, formatTime, weekRange } from '@/core/time';
import { useFocusMinutes, useProjects } from '@/hooks';
import { usePermissions, useRequestPermission } from '@/hooks/useSystem';
import {
  focusPlanTotals,
  previewFocusPlan,
  useFocusControl,
  useLiveFocus,
  useRecentFocusSummaries,
  useStartFocusPlan,
  type FocusPlanInput,
  type FocusSnapshot,
  type SessionPhase,
} from '@/hooks/useFocusRuntime';
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
  Txt,
  useConfirm,
  useToast,
} from '@/ui/components';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { REFLOW_MS } from '@/ui/motion';
import { useProgressWidth, useStaggeredEntry } from '@/ui/motionHooks';
import { useTheme } from '@/ui/ThemeProvider';

const VOICE_HINT =
  "Try: 'start a 2-hour study session for Math with 5-minute breaks every 25 minutes'";

type Preset = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  plan: Omit<FocusPlanInput, 'label'>;
};

const PRESETS: Preset[] = [
  { key: 'pomodoro', label: 'Pomodoro', icon: 'timer-outline', plan: { focusMinutes: 25, breakMinutes: 5, cycles: 4 } },
  { key: 'deep', label: 'Deep work', icon: 'telescope-outline', plan: { focusMinutes: 50, breakMinutes: 10, cycles: 2 } },
  { key: 'block', label: 'Single block', icon: 'square-outline', plan: { focusMinutes: 90, breakMinutes: 0, cycles: 1 } },
];

export default function FocusScreen() {
  return (
    <Screen back title="Focus">
      <ErrorBoundary
        label="focus"
        fallback={(error, reset) => <InlineError message={error.message} onRetry={reset} />}
      >
        <FocusBody />
      </ErrorBoundary>
    </Screen>
  );
}

function FocusBody() {
  const { snapshot, phases } = useLiveFocus();
  // A completed or cancelled snapshot lingers for a frame after the runtime
  // detaches; only a live one may claim the screen.
  const live = snapshot && (snapshot.status === 'running' || snapshot.status === 'paused') ? snapshot : null;

  return (
    <>
      {live ? <SilentAlarmsWarning /> : null}
      {live ? <RunningSession snapshot={live} phases={phases} /> : <QuickStart />}
      <History />
    </>
  );
}

/**
 * Says out loud what the timer would otherwise fail at quietly.
 *
 * Phase changes are dated local notifications, so with notifications refused a
 * backgrounded timer runs to the end of a focus block and never announces it.
 * The scheduler already handles that gracefully — it logs and carries on — but
 * gracefully is not the same as visibly, and the user finds out by missing the
 * end of a Pomodoro. Shown only while something is actually running: it is a
 * warning about this timer, not a permission inventory.
 */
function SilentAlarmsWarning() {
  const { colors, spacing } = useTheme();
  const permissions = usePermissions();
  const request = useRequestPermission();
  const toast = useToast();

  const level = permissions.data?.notifications?.level;
  if (level !== 'denied' && level !== 'blocked') return null;

  return (
    <Card accent={colors.warning} style={{ gap: spacing.sm }}>
      <Txt variant="bodyStrong" tone="warning">
        This timer cannot chime
      </Txt>
      <Txt variant="caption" tone="secondary">
        Phase changes are announced by a notification, and those are switched off. The countdown
        keeps running while you watch it; leave the app and nothing will tell you the block ended.
      </Txt>
      <Button
        label={level === 'blocked' ? 'Open settings' : 'Turn on notifications'}
        size="sm"
        variant="secondary"
        onPress={() => {
          if (level === 'blocked') {
            void Linking.openSettings().catch(() =>
              toast.show({ message: 'Could not open settings.', tone: 'danger' }),
            );
            return;
          }
          request.mutate('notifications', {
            onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
          });
        }}
      />
    </Card>
  );
}

/* --------------------------------------------------------------- running -- */

function RunningSession({ snapshot, phases }: { snapshot: FocusSnapshot; phases: SessionPhase[] }) {
  const { colors, spacing, radius } = useTheme();
  const toast = useToast();
  const control = useFocusControl();
  const confirm = useConfirm();

  const paused = snapshot.status === 'paused';
  const isBreak = snapshot.phase.kind === 'break';
  const phaseColor = isBreak ? colors.info : colors.accent;
  const tint = paused ? colors.textTertiary : phaseColor;

  const span = snapshot.phaseElapsedMs + snapshot.phaseRemainingMs;
  const progress = span > 0 ? snapshot.phaseElapsedMs / span : 0;
  // The runtime ticks once a second, so this bar used to redraw its own length
  // in a hard step every second — the one place in the app where a jump is
  // literally a clock being wrong between beats. `useProgressWidth` clamps and
  // handles `0/0` itself, which is what the Math.min/Math.max here were doing.
  const fillStyle = useProgressWidth(progress);

  const run = (action: 'pause' | 'resume' | 'skip' | 'stop') => {
    control.mutate(action, {
      onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
    });
  };

  const confirmStop = () => {
    confirm.ask({
      title: 'Stop this session?',
      message: `${snapshot.label} will be logged as cancelled.`,
      cancelLabel: 'Keep going',
      confirmLabel: 'Stop',
      onConfirm: () => run('stop'),
    });
  };

  return (
    <>
    <Card padded={false}>
      <View style={{ padding: spacing.lg, gap: spacing.md }}>
        <View style={styles.rowBetween}>
          <View style={{ flex: 1, gap: 2 }}>
            <Txt variant="micro" style={{ color: tint, letterSpacing: 1 }}>
              {isBreak ? 'BREAK' : 'FOCUS'}
            </Txt>
            <Txt variant="bodyStrong" numberOfLines={1}>
              {snapshot.label}
            </Txt>
          </View>
          {paused ? <Badge label="Paused" tone="warning" /> : null}
          {snapshot.subject ? <Badge label={snapshot.subject} tone="neutral" /> : null}
        </View>

        <Txt
          variant="timer"
          center
          accessibilityLabel={`${formatClock(snapshot.phaseRemainingMs)} left in this ${snapshot.phase.kind}`}
          style={{ color: paused ? colors.textTertiary : colors.text }}
        >
          {snapshot.clock}
        </Txt>

        <View
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
          style={[styles.track, { backgroundColor: colors.surfaceSunken, borderRadius: radius.pill }]}
        >
          <Animated.View
            style={[
              {
                height: '100%',
                backgroundColor: tint,
                borderRadius: radius.pill,
              },
              fillStyle,
            ]}
          />
        </View>

        <View style={styles.rowBetween}>
          <Txt variant="caption" tone="tertiary">
            Phase {snapshot.phaseIndex + 1} of {snapshot.phaseCount}
          </Txt>
          <Txt variant="caption" tone="tertiary">
            {formatClock(snapshot.totalRemainingMs)} left in total
          </Txt>
        </View>

        {phases.length > 0 ? <PhaseStrip phases={phases} current={snapshot.phaseIndex} /> : null}
      </View>

      <Divider />

      <View style={{ flexDirection: 'row', gap: spacing.sm, padding: spacing.md }}>
        <Button
          label={paused ? 'Resume' : 'Pause'}
          icon={paused ? 'play' : 'pause'}
          variant="primary"
          onPress={() => run(paused ? 'resume' : 'pause')}
          disabled={control.isPending}
          style={{ flex: 1 }}
        />
        <Button
          label="Skip"
          icon="play-skip-forward"
          onPress={() => run('skip')}
          disabled={control.isPending}
          accessibilityLabel="Skip this phase"
          style={{ flex: 1 }}
        />
        <Button
          label="Stop"
          icon="stop"
          variant="danger"
          onPress={confirmStop}
          disabled={control.isPending}
          style={{ flex: 1 }}
        />
      </View>
    </Card>
    {confirm.dialog}
    </>
  );
}

/** The plan as a row of pills: done and current are filled, the rest outlined. */
function PhaseStrip({ phases, current }: { phases: SessionPhase[]; current: number }) {
  const { colors, spacing } = useTheme();
  // Mounted when a session starts, so the plan lays itself out in front of you
  // — which is the one moment the shape of the next two hours is worth reading.
  const arrive = useStaggeredEntry();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: spacing.xs, paddingVertical: 2, alignItems: 'center' }}
    >
      {phases.map((phase, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <Animated.View
            key={`${phase.kind}-${index}`}
            entering={arrive(index)}
            accessibilityLabel={`${phase.kind}, ${phase.minutes} minutes${
              active ? ', running now' : done ? ', done' : ''
            }`}
          >
            <Chip
              size="sm"
              label={String(phase.minutes)}
              selected={done || active}
              color={
                done
                  ? colors.borderStrong
                  : phase.kind === 'break'
                    ? colors.info
                    : colors.accent
              }
            />
          </Animated.View>
        );
      })}
    </ScrollView>
  );
}

/* ------------------------------------------------------------ quick start -- */

/**
 * The presets, plus what the session is about.
 *
 * There is no numeric builder: total / focus / break had to agree with one
 * another and with a cycle cap the screen never showed, so a typed 9999 ran as
 * something else entirely. Any plan the presets do not cover is one spoken
 * sentence away — `timer_start` in the executor builds it.
 */
function QuickStart() {
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const start = useStartFocusPlan();
  const projects = useProjects('active');
  // The project chips only; `PRESETS` below is a constant, and staggering three
  // rows that are always there and always the same is animation for its own
  // sake — the wave is for content that arrived, not for furniture.
  const arrive = useStaggeredEntry();

  const [subject, setSubject] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);

  const launch = (preset: Preset) => {
    // A row cannot go grey the way the old Start button did, and starting twice
    // retires the first session as "cancelled" — so the guard moves in here.
    if (start.isPending) return;
    const project = projects.data?.find((p) => p.id === projectId) ?? null;
    start.mutate(
      {
        // What the session is about beats what its rhythm is called: "Physics"
        // is what the lock screen should say, not "Pomodoro".
        label: subject.trim() || project?.name || preset.label,
        subject: subject.trim() || null,
        projectId,
        ...preset.plan,
      },
      { onError: (error) => toast.show({ message: error.message, tone: 'danger' }) },
    );
  };

  return (
    <Section title="Quick start">
      <Card padded={false}>
        <View style={{ padding: spacing.md, gap: spacing.md }}>
          <Input
            label="Subject"
            value={subject}
            onChangeText={setSubject}
            placeholder="Optional — Math, thesis, inbox…"
          />

          {projects.data && projects.data.length > 0 ? (
            <View style={{ gap: spacing.xs }}>
              <Txt variant="micro" tone="tertiary" style={{ letterSpacing: 0.6 }}>
                PROJECT
              </Txt>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: spacing.xs }}
              >
                {projects.data.map((project, index) => (
                  <Animated.View
                    key={project.id}
                    entering={arrive(index)}
                    layout={LinearTransition.duration(REFLOW_MS)}
                  >
                    <Chip
                      label={project.name}
                      selected={projectId === project.id}
                      // Tapping the selected one clears it: the field is optional.
                      onPress={() => setProjectId(projectId === project.id ? null : project.id)}
                    />
                  </Animated.View>
                ))}
              </ScrollView>
            </View>
          ) : null}
        </View>

        {PRESETS.map((preset) => {
          const phases = previewFocusPlan({ label: preset.label, ...preset.plan });
          return (
            <View key={preset.key}>
              <Divider />
              <Card
                padded={false}
                onPress={() => launch(preset)}
                style={{ borderWidth: 0, backgroundColor: 'transparent' }}
                accessibilityLabel={`Start ${preset.label}`}
              >
                <View style={styles.presetRow}>
                  <Ionicons name={preset.icon} size={19} color={colors.accent} />
                  <View style={{ flex: 1, gap: 1 }}>
                    <Txt variant="bodyStrong">{preset.label}</Txt>
                    <Txt variant="caption" tone="tertiary">
                      {describePlan(phases)}
                    </Txt>
                  </View>
                  <Ionicons name="play" size={16} color={colors.textTertiary} />
                </View>
              </Card>
            </View>
          );
        })}
      </Card>

      <Txt variant="caption" tone="tertiary">
        {VOICE_HINT}
      </Txt>
    </Section>
  );
}

/* --------------------------------------------------------------- history -- */

/** A record, not a launcher: a session is started above, or by saying so. */
function History() {
  const { colors, spacing } = useTheme();
  const { summaries, isLoading, isError, refetch } = useRecentFocusSummaries();
  const arrive = useStaggeredEntry({ from: 'below' });

  // Fixed on mount: the week only turns over at midnight on Monday, and a fresh
  // range on every render would be a new query key every render.
  const week = useMemo(() => weekRange(), []);
  const weekMinutes = useFocusMinutes(week.start, week.end);

  return (
    <Section title="History">
      <Card padded={false}>
        <View style={[styles.presetRow, { paddingVertical: 10 }]}>
          <Ionicons name="flame-outline" size={19} color={colors.success} />
          <Txt variant="body" style={{ flex: 1 }}>
            Focused this week
          </Txt>
          <Txt variant="bodyStrong" tone={weekMinutes.data ? 'success' : 'tertiary'}>
            {formatDuration(weekMinutes.data ?? 0)}
          </Txt>
        </View>

        {isError ? (
          <>
            <Divider />
            <InlineError message="Could not read your recent sessions." onRetry={refetch} />
          </>
        ) : isLoading ? (
          <>
            <Divider />
            <SkeletonRows />
          </>
        ) : summaries.length === 0 ? (
          <>
            <Divider />
            <EmptyState
              icon="timer-outline"
              title="No sessions yet"
              hint="Every session you run is logged here."
            />
          </>
        ) : (
          summaries.map((summary, index) => (
            // Finishing a session puts a new row at the top of this card and
            // pushes the rest down; the entrance is what marks which one is new.
            <Animated.View
              key={summary.session.id}
              entering={arrive(index)}
              layout={LinearTransition.duration(REFLOW_MS)}
            >
              <Divider />
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.md,
                  paddingHorizontal: spacing.md,
                  paddingVertical: 10,
                }}
              >
                <View style={{ flex: 1, gap: 1 }}>
                  <Txt variant="body" numberOfLines={1}>
                    {summary.session.label}
                  </Txt>
                  <Txt variant="caption" tone="tertiary">
                    {formatDayHeading(summary.session.startedAt)} ·{' '}
                    {formatTime(summary.session.startedAt)}
                    {summary.session.status === 'cancelled' ? ' · stopped early' : ''}
                  </Txt>
                </View>
                <Txt variant="mono" tone={summary.minutes > 0 ? 'success' : 'tertiary'}>
                  {formatDuration(summary.minutes)}
                </Txt>
              </View>
            </Animated.View>
          ))
        )}
      </Card>
    </Section>
  );
}

/* ----------------------------------------------------------------- bits --- */

function SkeletonRows() {
  const { colors, radius, spacing } = useTheme();
  return (
    <View style={{ padding: spacing.md, gap: spacing.md }}>
      {[0, 1, 2].map((i) => (
        <View
          key={i}
          style={{
            height: 14,
            width: `${70 - i * 12}%`,
            backgroundColor: colors.surfaceSunken,
            borderRadius: radius.sm,
          }}
        />
      ))}
    </View>
  );
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md }}>
      <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
      <Txt variant="caption" tone="secondary" style={{ flex: 1 }} numberOfLines={2}>
        {message}
      </Txt>
      <Button label="Retry" size="sm" onPress={onRetry} />
    </View>
  );
}

/* ---------------------------------------------------------------- helpers -- */

function describePlan(phases: SessionPhase[]): string {
  const { totalMinutes } = focusPlanTotals(phases);
  const focus = phases.filter((phase) => phase.kind === 'focus');
  const first = focus[0]?.minutes ?? 0;
  const rest = phases.find((phase) => phase.kind === 'break');
  const breaks = rest ? `${formatDuration(rest.minutes)} breaks` : 'no breaks';
  const blocks =
    focus.length > 1 ? `${focus.length} × ${formatDuration(first)}` : formatDuration(first);
  return `${blocks} · ${breaks} · ${formatDuration(totalMinutes)} total`;
}

const styles = StyleSheet.create({
  rowBetween: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  track: { height: 6, overflow: 'hidden' },
  presetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    minHeight: 44,
  },
});
