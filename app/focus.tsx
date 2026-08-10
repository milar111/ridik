import { useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { formatClock, formatDayHeading, formatDuration, formatTime, weekRange } from '@/core/time';
import { useFocusMinutes, useProjects } from '@/hooks';
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
  useToast,
} from '@/ui/components';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
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
    <Screen title="Focus">
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
      {live ? <RunningSession snapshot={live} phases={phases} /> : <QuickStart />}
      <History idle={!live} />
    </>
  );
}

/* --------------------------------------------------------------- running -- */

function RunningSession({ snapshot, phases }: { snapshot: FocusSnapshot; phases: SessionPhase[] }) {
  const { colors, spacing, radius } = useTheme();
  const toast = useToast();
  const control = useFocusControl();

  const paused = snapshot.status === 'paused';
  const isBreak = snapshot.phase.kind === 'break';
  const phaseColor = isBreak ? colors.info : colors.accent;
  const tint = paused ? colors.textTertiary : phaseColor;

  const span = snapshot.phaseElapsedMs + snapshot.phaseRemainingMs;
  const progress = span > 0 ? snapshot.phaseElapsedMs / span : 0;

  const run = (action: 'pause' | 'resume' | 'skip' | 'stop') => {
    control.mutate(action, {
      onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
    });
  };

  const confirmStop = () => {
    Alert.alert('Stop this session?', `${snapshot.label} will be logged as cancelled.`, [
      { text: 'Keep going', style: 'cancel' },
      { text: 'Stop', style: 'destructive', onPress: () => run('stop') },
    ]);
  };

  return (
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
          <View
            style={{
              width: `${Math.min(100, Math.max(0, progress * 100))}%`,
              height: '100%',
              backgroundColor: tint,
              borderRadius: radius.pill,
            }}
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
  );
}

/**
 * The plan as a row of pills: done and current are filled, the rest outlined.
 * `current` is -1 for the builder's preview, where no phase has started yet.
 */
function PhaseStrip({ phases, current }: { phases: SessionPhase[]; current: number }) {
  const { colors, spacing } = useTheme();
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
          <View
            key={`${phase.kind}-${index}`}
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
          </View>
        );
      })}
    </ScrollView>
  );
}

/* ------------------------------------------------------------ quick start -- */

function QuickStart() {
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const start = useStartFocusPlan();
  const projects = useProjects('active');

  const [totalMinutes, setTotalMinutes] = useState('60');
  const [focusMinutes, setFocusMinutes] = useState('25');
  const [breakMinutes, setBreakMinutes] = useState('5');
  const [subject, setSubject] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);

  const custom = useMemo<FocusPlanInput>(() => {
    const project = projects.data?.find((p) => p.id === projectId) ?? null;
    return {
      label: subject.trim() || project?.name || 'Focus session',
      subject: subject.trim() || null,
      projectId,
      totalMinutes: toMinutes(totalMinutes, 60),
      focusMinutes: toMinutes(focusMinutes, 25),
      breakMinutes: toMinutes(breakMinutes, 5, 0),
    };
  }, [breakMinutes, focusMinutes, projectId, projects.data, subject, totalMinutes]);

  const preview = useMemo(() => previewFocusPlan(custom), [custom]);

  const launch = (input: FocusPlanInput) => {
    start.mutate(input, {
      onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
    });
  };

  return (
    <>
      <Section title="Quick start">
        <Card padded={false}>
          {PRESETS.map((preset, index) => {
            const phases = previewFocusPlan({ label: preset.label, ...preset.plan });
            return (
              <View key={preset.key}>
                {index > 0 ? <Divider inset={44} /> : null}
                <Card
                  padded={false}
                  onPress={() => launch({ label: preset.label, ...preset.plan })}
                  style={{ borderWidth: 0, backgroundColor: 'transparent' }}
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
      </Section>

      <Section title="Custom">
        <Card>
          <View style={{ gap: spacing.md }}>
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <Input
                label="Total min"
                value={totalMinutes}
                onChangeText={setTotalMinutes}
                keyboardType="number-pad"
                containerStyle={{ flex: 1 }}
              />
              <Input
                label="Focus min"
                value={focusMinutes}
                onChangeText={setFocusMinutes}
                keyboardType="number-pad"
                containerStyle={{ flex: 1 }}
              />
              <Input
                label="Break min"
                value={breakMinutes}
                onChangeText={setBreakMinutes}
                keyboardType="number-pad"
                containerStyle={{ flex: 1 }}
              />
            </View>

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
                  {projects.data.map((project) => (
                    <Chip
                      key={project.id}
                      label={project.name}
                      selected={projectId === project.id}
                      // Tapping the selected one clears it: the field is optional.
                      onPress={() => setProjectId(projectId === project.id ? null : project.id)}
                    />
                  ))}
                </ScrollView>
              </View>
            ) : null}

            <View style={{ gap: spacing.xs }}>
              <Txt variant="micro" tone="tertiary" style={{ letterSpacing: 0.6 }}>
                PLAN
              </Txt>
              {preview.length > 0 ? (
                <>
                  <PhaseStrip phases={preview} current={-1} />
                  <Txt variant="caption" tone="secondary">
                    {describePlan(preview)}
                  </Txt>
                </>
              ) : (
                <Txt variant="caption" tone="danger">
                  Those numbers do not make a session.
                </Txt>
              )}
            </View>

            <Button
              label="Start session"
              icon="play"
              variant="primary"
              fullWidth
              loading={start.isPending}
              disabled={preview.length === 0}
              onPress={() => launch(custom)}
            />
          </View>
        </Card>
      </Section>
    </>
  );
}

/* --------------------------------------------------------------- history -- */

function History({ idle }: { idle: boolean }) {
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const start = useStartFocusPlan();
  const { summaries, isLoading, isError, refetch } = useRecentFocusSummaries();

  // Fixed on mount: the week only turns over at midnight on Monday, and a fresh
  // range on every render would be a new query key every render.
  const week = useMemo(() => weekRange(), []);
  const weekMinutes = useFocusMinutes(week.start, week.end);

  const repeat = (summary: (typeof summaries)[number]) => {
    const plan = planFrom(summary.phases);
    if (!plan) return;
    start.mutate(
      {
        label: summary.session.label,
        subject: summary.session.subject,
        projectId: summary.session.projectId,
        ...plan,
      },
      { onError: (error) => toast.show({ message: error.message, tone: 'danger' }) },
    );
  };

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
            <EmptyState icon="timer-outline" title="No sessions yet" hint={VOICE_HINT} />
          </>
        ) : (
          summaries.map((summary) => {
            const row = (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: 10 }}>
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
                <Txt
                  variant="mono"
                  tone={summary.minutes > 0 ? 'success' : 'tertiary'}
                >
                  {formatDuration(summary.minutes)}
                </Txt>
                {idle ? <Ionicons name="refresh" size={15} color={colors.textTertiary} /> : null}
              </View>
            );
            return (
              <View key={summary.session.id}>
                <Divider />
                {idle && summary.phases.length > 0 ? (
                  <Card
                    padded={false}
                    onPress={() => repeat(summary)}
                    style={{ borderWidth: 0, backgroundColor: 'transparent' }}
                    accessibilityLabel={`Run ${summary.session.label} again`}
                  >
                    {row}
                  </Card>
                ) : (
                  row
                )}
              </View>
            );
          })
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

function toMinutes(raw: string, fallback: number, min = 1): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, value);
}

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

/** Rebuilds the input that produced a plan, so a past session can be re-run. */
function planFrom(phases: SessionPhase[]): Pick<FocusPlanInput, 'focusMinutes' | 'breakMinutes' | 'cycles'> | null {
  const focus = phases.filter((phase) => phase.kind === 'focus');
  if (focus.length === 0) return null;
  return {
    focusMinutes: focus[0]!.minutes,
    breakMinutes: phases.find((phase) => phase.kind === 'break')?.minutes ?? 0,
    cycles: focus.length,
  };
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
