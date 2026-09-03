import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { now } from '@/core/clock';
import { countLabel, truncate } from '@/core/format';
import { ok, toAppError, type Result } from '@/core/result';
import {
  currentZone,
  epochToLocal,
  formatDayHeading,
  formatDuration,
  formatTime,
  localDateOf,
  localToEpoch,
  monthRange,
  todayLocalDate,
  weekRange,
  type LocalDate,
} from '@/core/time';
import type { ActivityEntry } from '@/db/schema';
import { copyToClipboard, shareAsFile, weeklyStandup } from '@/features/export';
import { useActivitySummary, useLogActivity, useRemoveActivityEntry } from '@/hooks';
import type { ActivitySummary } from '@/repositories/activity';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { SheetCard } from '@/ui/components/SheetCard';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale , useStaggeredEntry } from '@/ui/motionHooks';
import {
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  Input,
  Screen,
  Segmented,
  Txt,
  useConfirm,
  useToast,
} from '@/ui/components';
import { REFLOW_MS } from '@/ui/motion';
import { colorForTag } from '@/ui/theme';

type Period = 'day' | 'week' | 'month';

const PERIODS: { value: Period; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

const TITLES: Record<Period, string> = {
  day: 'Daily standup',
  week: 'Weekly standup',
  month: 'Monthly log',
};

function reason(error: unknown): string {
  return toAppError(error).userMessage;
}

export default function ActivityScreen() {
  const [period, setPeriod] = useState<Period>('week');
  const [logging, setLogging] = useState(false);

  return (
    <Screen
      back
      title="Activity"
      right={
        <Button icon="add" label="Add" size="sm" variant="primary" onPress={() => setLogging(true)} />
      }
    >
      <Segmented options={PERIODS} value={period} onChange={setPeriod} />
      <ErrorBoundary label="activity">
        <ActivityBody period={period} />
      </ErrorBoundary>
      {logging ? <LogSheet onClose={() => setLogging(false)} /> : null}
    </Screen>
  );
}

function ActivityBody({ period }: { period: Period }) {
  const { spacing } = useTheme();
  const zone = currentZone();
  const toast = useToast();

  const range = useMemo(() => {
    const at = now();
    if (period === 'day') {
      const date = todayLocalDate(zone);
      return { from: date, to: date };
    }
    const bounds = period === 'week' ? weekRange(at, zone) : monthRange(at, zone);
    // Both ends inclusive here, but `weekRange`/`monthRange` end is exclusive.
    return { from: localDateOf(bounds.start, zone), to: localDateOf(bounds.end - 1, zone) };
  }, [period, zone]);

  const summary = useActivitySummary(range);
  const remove = useRemoveActivityEntry();
  const confirm = useConfirm();
  const [exporting, setExporting] = useState(false);
  // The day is the unit that arrives; its entries come with it. Changing period
  // rebuilds the day buckets, so the wave doubles as the answer to the tap.
  const arrive = useStaggeredEntry({ from: 'below' });

  const names = useMemo(() => {
    const projects = new Map<string, string>();
    const habits = new Map<string, string>();
    for (const bucket of summary.data?.byProject ?? []) {
      if (bucket.name) projects.set(bucket.id, bucket.name);
    }
    for (const bucket of summary.data?.byHabit ?? []) {
      if (bucket.name) habits.set(bucket.id, bucket.name);
    }
    return { projects, habits };
  }, [summary.data]);

  const confirmDelete = (entry: ActivityEntry) => {
    confirm.ask({
      title: 'Delete this entry?',
      message: truncate(entry.description, 80),
      onConfirm: () =>
        remove.mutate(entry.id, {
          onSuccess: () => toast.show({ message: 'Entry deleted' }),
          onError: (error) =>
            toast.show({ message: 'Could not delete that', detail: reason(error), tone: 'danger' }),
        }),
    });
  };

  if (summary.isError) {
    return <RetryRow message={reason(summary.error)} onRetry={() => void summary.refetch()} />;
  }

  const data = summary.data;
  if (!data) return <SkeletonRows />;

  const spanLabel = `${epochToLocal(dayEpoch(range.from, zone), zone).toFormat('d LLL')} – ${epochToLocal(
    dayEpoch(range.to, zone),
    zone,
  ).toFormat('d LLL')}`;

  // Newest first on screen; the exported document stays chronological because a
  // standup is read forwards.
  const days = [...data.byDay].reverse();
  const topProject = data.byProject[0];

  return (
    <View style={{ gap: spacing.lg }}>
      <View style={styles.spread}>
        <Txt variant="caption" tone="secondary">
          {period === 'day' ? formatDayHeading(dayEpoch(range.from, zone), zone) : spanLabel}
        </Txt>
        <Button
          label="Export"
          icon="share-outline"
          size="sm"
          disabled={data.entries.length === 0}
          onPress={() => setExporting(true)}
        />
      </View>

      <Card>
        <View style={styles.summaryRow}>
          <Stat value={String(data.entries.length)} label="entries" />
          <Stat value={data.totalMinutes > 0 ? formatDuration(data.totalMinutes) : '—'} label="tracked" />
          <Stat
            flex={1.6}
            // 18 rather than 14: the wider column holds "Robotics build" whole
            // at 114pt of its 143, and 14 cut it to "Robotics b…" for nothing.
            value={topProject?.name ? truncate(topProject.name, 18) : '—'}
            label="top project"
            detail={topProject ? formatDuration(topProject.minutes) : undefined}
          />
        </View>
      </Card>

      {data.entries.length === 0 ? (
        <EmptyState
          icon="pulse-outline"
          title="Nothing logged in this period"
          hint="Try: 'logged 45 minutes of workout'"
        />
      ) : (
        days.map((day, dayIndex) => (
          <Animated.View
            key={day.date}
            entering={arrive(dayIndex)}
            layout={LinearTransition.duration(REFLOW_MS)}
            style={{ gap: 4 }}
          >
            <View style={styles.spread}>
              <Txt variant="micro" tone="tertiary" style={styles.tracked}>
                {/* The bucket's own local date, not its first entry: a row
                    logged just after midnight would otherwise name the day
                    before. */}
                {formatDayHeading(dayEpoch(day.date, zone), zone).toUpperCase()}
              </Txt>
              <Txt variant="micro" tone="tertiary">
                {day.minutes > 0
                  ? `${formatDuration(day.minutes)} · ${day.entries.length}`
                  : countLabel(day.entries.length, 'entry', 'entries')}
              </Txt>
            </View>
            <Card padded={false}>
              {day.entries.map((entry, i) => (
                // `layout` only, no second entrance: deleting an entry has to
                // close the gap it leaves, but the day it belongs to has
                // already announced itself.
                <Animated.View key={entry.id} layout={LinearTransition.duration(REFLOW_MS)}>
                  {i > 0 ? <Divider inset={spacing.md} /> : null}
                  <EntryRow
                    entry={entry}
                    projectName={entry.projectId ? names.projects.get(entry.projectId) : undefined}
                    habitName={entry.habitId ? names.habits.get(entry.habitId) : undefined}
                    onDelete={() => confirmDelete(entry)}
                  />
                </Animated.View>
              ))}
            </Card>
          </Animated.View>
        ))
      )}

      {exporting ? (
        <ExportSheet
          summary={data}
          period={period}
          range={range}
          zone={zone}
          onClose={() => setExporting(false)}
        />
      ) : null}
      {confirm.dialog}
    </View>
  );
}

/** Noon, because some zones skip midnight itself on the switchover day. */
function dayEpoch(date: LocalDate, zone: string): number {
  return localToEpoch(`${date}T12:00`, zone);
}

/**
 * `flex` because equal thirds is the wrong split for these three.
 *
 * "ENTRIES" is 50pt of tracked micro and "TRACKED" 56, while
 * "TOP PROJECT · 3H 15M" is 131 — so a third of the card, 107pt, wrapped the
 * last caption onto a second line and truncated the project name above it, and
 * the card grew a line to hold the overflow. All three fit comfortably in the
 * 321pt available; they just do not want the same share of it.
 */
function Stat({
  value,
  label,
  detail,
  flex = 1,
}: {
  value: string;
  label: string;
  detail?: string;
  flex?: number;
}) {
  return (
    <View style={{ flex, gap: 2 }}>
      <Txt variant="heading" numberOfLines={1}>
        {value}
      </Txt>
      {/* One line, always: this row's height is the card's height, and a
          caption that wraps takes the other two stats with it. */}
      <Txt variant="micro" tone="tertiary" numberOfLines={1} style={styles.tracked}>
        {label.toUpperCase()}
        {detail ? ` · ${detail}` : ''}
      </Txt>
    </View>
  );
}

function EntryRow({
  entry,
  projectName,
  habitName,
  onDelete,
}: {
  entry: ActivityEntry;
  projectName?: string;
  habitName?: string;
  onDelete: () => void;
}) {
  const { colors, spacing } = useTheme();
  const press = usePressScale({ scale: 0.98 });
  return (
    <AnimatedPressable
      // A tap has nowhere to go — the row is the record — so delete is exposed
      // as an explicit accessibility action rather than hidden behind a gesture.
      // It stays because voice cannot undo a log: `activity_log` writes, and no
      // tool in the LLM contract removes.
      accessibilityRole="text"
      accessibilityLabel={entry.description}
      accessibilityActions={[{ name: 'longpress', label: 'Delete entry' }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'longpress') onDelete();
      }}
      onLongPress={onDelete}
      {...press.handlers}
      style={[styles.entryRow, { paddingHorizontal: spacing.md }, press.style]}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Txt variant="body" numberOfLines={2}>
          {entry.description}
        </Txt>
        <View style={styles.meta}>
          <Txt variant="micro" tone="tertiary">
            {formatTime(entry.loggedAt)}
          </Txt>
          {habitName ? (
            <Chip label={habitName} size="sm" icon="flame" color={colorForTag(habitName)} />
          ) : null}
          {projectName ? (
            <Chip label={projectName} size="sm" icon="folder-outline" color={colorForTag(projectName)} />
          ) : null}
        </View>
      </View>
      {entry.durationMinutes ? (
        <Txt variant="caption" style={{ color: colors.textSecondary }}>
          {formatDuration(entry.durationMinutes)}
        </Txt>
      ) : null}
    </AnimatedPressable>
  );
}

/**
 * Logging by hand.
 *
 * `activity_log` writes and nothing in the LLM contract corrects, so a mis-heard
 * entry could be deleted from a row here but never replaced — the screen could
 * take rows away and not put one back. Description and duration are the whole
 * form: `ActivityLogInput` also takes a habit name and a project id, and neither
 * survives being typed. An unmatched habit name creates a second habit rather
 * than failing, and a project id is not something a person knows.
 */
function LogSheet({ onClose }: { onClose: () => void }) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const log = useLogActivity();

  const [description, setDescription] = useState('');
  const [minutes, setMinutes] = useState('');

  const trimmed = description.trim();
  const rawMinutes = minutes.trim();
  // Blank is not an error: most of what gets logged has no clock on it.
  const parsedMinutes = rawMinutes === '' ? null : Number(rawMinutes);
  const minutesError =
    parsedMinutes !== null && (!Number.isFinite(parsedMinutes) || parsedMinutes <= 0)
      ? 'Minutes must be a number above zero.'
      : null;
  const invalid = trimmed === '' || minutesError !== null;

  const submit = () => {
    // The keyboard's Done key gets here without going past the disabled button.
    if (invalid) return;
    log.mutate(
      {
        description: trimmed,
        // `duration_minutes` is an integer column, and a keyboard that offers a
        // decimal point would otherwise write 45.5 into it.
        durationMinutes: parsedMinutes === null ? undefined : Math.round(parsedMinutes),
        // The feed defaults to 'voice' because that was the only way in for most
        // of this app's life. This one was typed, and the row should say so.
        source: 'manual',
      },
      {
        onSuccess: () => {
          toast.show({ message: 'Entry logged', tone: 'success' });
          onClose();
        },
        onError: (error) =>
          toast.show({ message: 'Could not log that', detail: reason(error), tone: 'danger' }),
      },
    );
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]}
        onPress={onClose}
      />
      {/* A Modal is its own window on Android, so the activity's adjustResize
          never reaches it and the keyboard covers the field it opened for.
          `box-none` keeps the backdrop under this one tappable. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.sheetWrap}
        pointerEvents="box-none"
      >
        <SheetCard
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              paddingBottom: insets.bottom + spacing.md,
            },
          ]}
        >
          <Txt variant="heading">Log an entry</Txt>

          <Input
            label="What you did"
            testID="activity-description"
            value={description}
            onChangeText={setDescription}
            placeholder="Rewrote the pump firmware"
            autoFocus
            returnKeyType="next"
            error={
              description.length > 0 && trimmed === '' ? 'An entry needs a description.' : undefined
            }
          />

          <Input
            label="Minutes (optional)"
            testID="activity-minutes"
            value={minutes}
            onChangeText={setMinutes}
            placeholder="45"
            keyboardType="number-pad"
            returnKeyType="done"
            onSubmitEditing={submit}
            error={minutesError ?? undefined}
          />

          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Button
              label="Log entry"
              variant="primary"
              disabled={invalid}
              loading={log.isPending}
              onPress={submit}
              style={{ flex: 1 }}
            />
            <Button label="Cancel" variant="ghost" onPress={onClose} />
          </View>
        </SheetCard>
      </KeyboardAvoidingView>
    </Modal>
  );
}

type ExportDoc = { markdown: string; title: string; filename: string };

type ExportAction = {
  key: string;
  label: string;
  hint: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** The Ok value is the sentence to toast — each route can end differently. */
  run: (doc: ExportDoc) => Promise<Result<string>>;
};

/**
 * Both routes hand out the *same* markdown document, so what the user pastes is
 * byte-for-byte what they send. Mail and PDF are not rows here: they are what
 * the share sheet already does with the file.
 */
const EXPORT_ACTIONS: ExportAction[] = [
  {
    key: 'copy',
    label: 'Copy markdown',
    hint: 'Paste it anywhere',
    icon: 'clipboard-outline',
    run: async (doc) => {
      const result = await copyToClipboard(doc.markdown);
      return result.ok ? ok('Markdown copied') : result;
    },
  },
  {
    key: 'share',
    label: 'Share file',
    hint: 'Mail it, print it, save it',
    icon: 'share-outline',
    run: async (doc) => {
      const result = await shareAsFile(doc.markdown, doc.filename, { dialogTitle: doc.title });
      return result.ok ? ok(result.value.shared ? 'Export shared' : 'File written') : result;
    },
  },
];

function ExportSheet({
  summary,
  period,
  range,
  zone,
  onClose,
}: {
  summary: ActivitySummary;
  period: Period;
  range: { from: LocalDate; to: LocalDate };
  zone: string;
  onClose: () => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const title = TITLES[period];
  const markdown = useMemo(
    () => weeklyStandup(summary, { zone, title, range }),
    [summary, zone, title, range],
  );
  const doc: ExportDoc = { markdown, title, filename: `ridik-${period}-${range.from}.md` };

  const run = (action: ExportAction) => {
    if (busy) return;
    setBusy(action.key);
    void action
      .run(doc)
      .then((result) => {
        if (result.ok) {
          toast.show({ message: result.value, tone: 'success' });
          onClose();
          return;
        }
        toast.show({ message: result.error.userMessage, tone: 'danger' });
      })
      .catch((error: unknown) =>
        toast.show({ message: 'That export failed', detail: reason(error), tone: 'danger' }),
      )
      .finally(() => setBusy(null));
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]}
        onPress={onClose}
      />
      <View style={styles.sheetWrap}>
        <SheetCard
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              paddingBottom: insets.bottom + spacing.md,
            },
          ]}
        >
          <View style={{ gap: 2, paddingBottom: spacing.sm }}>
            <Txt variant="heading">{title}</Txt>
            <Txt variant="caption" tone="tertiary">
              {countLabel(summary.entries.length, 'entry', 'entries')} ·{' '}
              {formatDuration(summary.totalMinutes)}
            </Txt>
          </View>

          <Card padded={false}>
            {EXPORT_ACTIONS.map((action, i) => (
              <View key={action.key}>
                {i > 0 ? <Divider inset={44} /> : null}
                <ExportRow
                  action={action}
                  running={busy === action.key}
                  disabled={busy !== null}
                  onPress={() => run(action)}
                />
              </View>
            ))}
          </Card>

          <Button label="Cancel" variant="ghost" fullWidth onPress={onClose} />
        </SheetCard>
      </View>
    </Modal>
  );
}

/**
 * One export action, extracted because each needs its own animation state and
 * a hook cannot be called from inside a `map`.
 *
 * `running` keeps its static 0.6 dim — that is the row saying it is working,
 * not the row answering a finger, and the two must not be the same cue. This
 * sits in a `Modal`, where an effect-driven shared value is the only mechanism
 * that reliably runs.
 */
function ExportRow({
  action,
  running,
  disabled,
  onPress,
}: {
  action: ExportAction;
  running: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const { colors, spacing } = useTheme();
  const press = usePressScale({ scale: 0.98, disabled });
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ busy: running, disabled }}
      disabled={disabled}
      onPress={onPress}
      {...press.handlers}
      style={[
        styles.actionRow,
        { paddingHorizontal: spacing.md, opacity: running ? 0.6 : 1 },
        press.style,
      ]}
    >
      <Ionicons name={action.icon} size={19} color={colors.accent} />
      <View style={{ flex: 1, gap: 1 }}>
        <Txt variant="bodyStrong">{action.label}</Txt>
        <Txt variant="micro" tone="tertiary">
          {action.hint}
        </Txt>
      </View>
      {running ? (
        <Ionicons name="ellipsis-horizontal" size={16} color={colors.textTertiary} />
      ) : (
        <Ionicons name="chevron-forward" size={15} color={colors.textTertiary} />
      )}
    </AnimatedPressable>
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

function SkeletonRows({ count = 5 }: { count?: number }) {
  const { colors, spacing } = useTheme();
  return (
    <Card padded={false}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={{ padding: spacing.md, gap: 7 }}>
          <View
            style={[
              styles.bone,
              { width: `${72 - i * 7}%`, height: 11, backgroundColor: colors.surfaceRaised },
            ]}
          />
          <View
            style={[styles.bone, { width: '28%', height: 8, backgroundColor: colors.surfaceSunken }]}
          />
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  tracked: { letterSpacing: 0.8 },
  summaryRow: { flexDirection: 'row', gap: 12 },
  entryRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingVertical: 9 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingVertical: 10 },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: { paddingHorizontal: 18, paddingTop: 14, gap: 10, borderWidth: StyleSheet.hairlineWidth },
  bone: { borderRadius: 4 },
});
