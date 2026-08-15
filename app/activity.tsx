import { useMemo, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
import { useActivitySummary, useRemoveActivityEntry } from '@/hooks';
import type { ActivitySummary } from '@/repositories/activity';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import {
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  Screen,
  Segmented,
  Txt,
  useToast,
} from '@/ui/components';
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

  return (
    <Screen back title="Activity">
      <Segmented options={PERIODS} value={period} onChange={setPeriod} />
      <ErrorBoundary label="activity">
        <ActivityBody period={period} />
      </ErrorBoundary>
    </Screen>
  );
}

function ActivityBody({ period }: { period: Period }) {
  const { spacing } = useTheme();
  const zone = currentZone();
  const toast = useToast();

  const range = useMemo(() => {
    const at = Date.now();
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
  const [exporting, setExporting] = useState(false);

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
    Alert.alert('Delete this entry?', truncate(entry.description, 80), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          remove.mutate(entry.id, {
            onSuccess: () => toast.show({ message: 'Entry deleted' }),
            onError: (error) =>
              toast.show({ message: 'Could not delete that', detail: reason(error), tone: 'danger' }),
          }),
      },
    ]);
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
            value={topProject?.name ? truncate(topProject.name, 14) : '—'}
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
        days.map((day) => (
          <View key={day.date} style={{ gap: 4 }}>
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
                <View key={entry.id}>
                  {i > 0 ? <Divider inset={spacing.md} /> : null}
                  <EntryRow
                    entry={entry}
                    projectName={entry.projectId ? names.projects.get(entry.projectId) : undefined}
                    habitName={entry.habitId ? names.habits.get(entry.habitId) : undefined}
                    onDelete={() => confirmDelete(entry)}
                  />
                </View>
              ))}
            </Card>
          </View>
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
    </View>
  );
}

/** Noon, because some zones skip midnight itself on the switchover day. */
function dayEpoch(date: LocalDate, zone: string): number {
  return localToEpoch(`${date}T12:00`, zone);
}

function Stat({ value, label, detail }: { value: string; label: string; detail?: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Txt variant="heading" numberOfLines={1}>
        {value}
      </Txt>
      <Txt variant="micro" tone="tertiary" style={styles.tracked}>
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
  return (
    <Pressable
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
      style={({ pressed }) => [
        styles.entryRow,
        { paddingHorizontal: spacing.md, opacity: pressed ? 0.6 : 1 },
      ]}
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
    </Pressable>
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
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]}
        onPress={onClose}
      />
      <View style={styles.sheetWrap}>
        <View
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
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={action.label}
                  accessibilityState={{ busy: busy === action.key, disabled: busy !== null }}
                  disabled={busy !== null}
                  onPress={() => run(action)}
                  style={({ pressed }) => [
                    styles.actionRow,
                    { paddingHorizontal: spacing.md, opacity: pressed || busy === action.key ? 0.6 : 1 },
                  ]}
                >
                  <Ionicons name={action.icon} size={19} color={colors.accent} />
                  <View style={{ flex: 1, gap: 1 }}>
                    <Txt variant="bodyStrong">{action.label}</Txt>
                    <Txt variant="micro" tone="tertiary">
                      {action.hint}
                    </Txt>
                  </View>
                  {busy === action.key ? (
                    <Ionicons name="ellipsis-horizontal" size={16} color={colors.textTertiary} />
                  ) : (
                    <Ionicons name="chevron-forward" size={15} color={colors.textTertiary} />
                  )}
                </Pressable>
              </View>
            ))}
          </Card>

          <Button label="Cancel" variant="ghost" fullWidth onPress={onClose} />
        </View>
      </View>
    </Modal>
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
