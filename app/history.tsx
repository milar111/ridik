/**
 * What was heard, what was done, and what went wrong.
 *
 * `llm_interactions` has recorded every turn since the orchestrator was built
 * and was read by nothing, which made the assistant the one part of this app
 * you had to take on faith. A summary of an action is the app's interpretation
 * of what you said; the transcript is the record. Ridik throws the audio away
 * the moment the recogniser is finished with it, so this table is the *only*
 * copy of the original — which makes showing it more important here, not less.
 *
 * Three consequences shape the screen:
 *
 *  - **The raw transcript is a first-class thing, not a debug field.** A row
 *    collapses to what you can read while scrolling and expands to the exact
 *    words, copyable, with the parameters each tool was actually called with.
 *    "Add milk to the shopping list" and a `checklist_add` that wrote to
 *    "Hardware" look identical until you can see the parameters.
 *  - **A failure is not hidden.** The filter can pull the trail down to the
 *    turns that errored or that had to ask a question, because those are the
 *    ones somebody came here to find.
 *  - **Clear must really clear.** `db/wipe.ts` preserves the spend counters
 *    from "erase everything" and nothing else; this table is not on that list
 *    and must never join it. `src/db/__tests__/wipe.test.ts` holds that line.
 *
 * Reachable from the menu. Home stays one screen.
 */
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { countLabel, truncate } from '@/core/format';
import { toAppError } from '@/core/result';
import { currentZone, formatDayHeading, formatTime, localDateOf, type LocalDate } from '@/core/time';
import { copyToClipboard } from '@/features/export';
import {
  useClearInteractionHistory,
  useForgetInteraction,
  useInteractionHistory,
  useInteractionStats,
} from '@/hooks';
import type { Interaction, InteractionAction, InteractionStatus } from '@/repositories/llmInteractions';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import {
  Button,
  Card,
  Divider,
  EmptyState,
  Screen,
  Section,
  Segmented,
  Txt,
  useConfirm,
  useToast,
} from '@/ui/components';
import { REFLOW_MS } from '@/ui/motion';
import { AnimatedPressable, usePressScale, useStaggeredEntry } from '@/ui/motionHooks';

type Filter = 'all' | 'clarify' | 'error';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'clarify', label: 'Asked back' },
  { value: 'error', label: 'Failed' },
];

/** How many turns one visit holds. Deep enough to scroll, cheap enough to keep. */
const PAGE = 100;

const STATUS: Record<InteractionStatus, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  ok: { label: 'Done', icon: 'checkmark-circle' },
  clarify: { label: 'Asked', icon: 'help-circle' },
  error: { label: 'Failed', icon: 'alert-circle' },
};

function reason(error: unknown): string {
  return toAppError(error).userMessage;
}

/**
 * Milliseconds, read as a person would say them.
 *
 * `latencyMs` is written on every turn and has never had a reader anywhere in
 * the app. It costs nothing to show and it is the only way to see that the
 * assistant got slower.
 */
export function formatLatency(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** A parameter value as one readable line. Objects and arrays keep their JSON. */
export function formatParameter(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export default function HistoryScreen() {
  const [filter, setFilter] = useState<Filter>('all');

  return (
    <Screen back title="History" subtitle="What Ridik heard, and what it did with it">
      <Segmented options={FILTERS} value={filter} onChange={setFilter} />
      <ErrorBoundary label="history">
        <HistoryBody filter={filter} onClearFilter={() => setFilter('all')} />
      </ErrorBoundary>
    </Screen>
  );
}

function HistoryBody({ filter, onClearFilter }: { filter: Filter; onClearFilter: () => void }) {
  const { spacing } = useTheme();
  const zone = currentZone();
  const toast = useToast();
  const confirm = useConfirm();

  const history = useInteractionHistory(
    filter === 'all' ? { limit: PAGE } : { limit: PAGE, status: filter },
  );
  const stats = useInteractionStats();
  const clear = useClearInteractionHistory();
  const forget = useForgetInteraction();

  const [expanded, setExpanded] = useState<string | null>(null);
  // The day is the unit that arrives; its turns come with it.
  const arrive = useStaggeredEntry({ from: 'below' });

  const days = useMemo(() => groupByDay(history.data ?? [], zone), [history.data, zone]);

  if (history.isError) {
    return <RetryRow message={reason(history.error)} onRetry={() => void history.refetch()} />;
  }
  if (!history.data) return <SkeletonRows />;

  const total = stats.data?.total ?? 0;
  const rows = history.data;

  const askToClear = () => {
    confirm.ask({
      title: 'Delete every transcript?',
      message:
        `${countLabel(total, 'turn')} go, with everything Ridik recorded about them. ` +
        'Your notes, tasks, events and everything else stay exactly as they are.',
      confirmLabel: 'Delete all',
      onConfirm: () =>
        clear.mutate(undefined, {
          onSuccess: (deleted) =>
            toast.show({ message: `${countLabel(deleted, 'turn')} deleted`, tone: 'neutral' }),
          onError: (error) =>
            toast.show({ message: 'Could not clear that', detail: reason(error), tone: 'danger' }),
        }),
    });
  };

  const askToForget = (turn: Interaction) => {
    confirm.ask({
      title: 'Forget this turn?',
      // Truncated: a dialog is a question, and a long dictation pasted into
      // one pushes its own buttons off the bottom of the card.
      message: truncate(turn.transcript, 120),
      confirmLabel: 'Forget',
      onConfirm: () =>
        forget.mutate(turn.id, {
          onSuccess: () => {
            setExpanded(null);
            toast.show({ message: 'Turn forgotten' });
          },
          onError: (error) =>
            toast.show({ message: 'Could not delete that', detail: reason(error), tone: 'danger' }),
        }),
    });
  };

  return (
    <View style={{ gap: spacing.lg }}>
      {total > 0 && stats.data ? <StatsCard stats={stats.data} /> : null}

      {rows.length === 0 ? (
        total === 0 ? (
          <EmptyState
            icon="chatbubble-ellipses-outline"
            title="Nothing has been said yet"
            hint={
              'Every time you speak to Ridik, this keeps the exact words it heard, ' +
              'the changes it made and anything that failed. It stays on this phone, ' +
              'and you can delete it from here.'
            }
          />
        ) : (
          <EmptyState
            icon="checkmark-circle-outline"
            title={filter === 'error' ? 'Nothing has failed' : 'Ridik has not had to ask'}
            hint={`None of your ${total} turns landed here.`}
          />
        )
      ) : (
        days.map((day, index) => (
          <Animated.View
            key={day.date}
            entering={arrive(index)}
            layout={LinearTransition.duration(REFLOW_MS)}
            style={{ gap: 4 }}
          >
            <View style={styles.spread}>
              <Txt variant="micro" tone="tertiary" style={styles.tracked}>
                {formatDayHeading(day.at, zone).toUpperCase()}
              </Txt>
              <Txt variant="micro" tone="tertiary">
                {countLabel(day.turns.length, 'turn')}
              </Txt>
            </View>
            <Card padded={false}>
              {day.turns.map((turn, i) => (
                <Animated.View key={turn.id} layout={LinearTransition.duration(REFLOW_MS)}>
                  {i > 0 ? <Divider inset={spacing.md} /> : null}
                  <TurnRow
                    turn={turn}
                    zone={zone}
                    expanded={expanded === turn.id}
                    onToggle={() => setExpanded((current) => (current === turn.id ? null : turn.id))}
                    onForget={() => askToForget(turn)}
                  />
                </Animated.View>
              ))}
            </Card>
          </Animated.View>
        ))
      )}

      {/* The filter can empty the list while the trail is full; the way out of
          that has to be on screen, not back up at a control that is now off it. */}
      {rows.length === 0 && total > 0 ? (
        <Button label="Show everything" variant="ghost" fullWidth onPress={onClearFilter} />
      ) : null}

      {total > 0 ? (
        <Section title="This record">
          <Card style={{ gap: spacing.sm }}>
            <Txt variant="caption" tone="secondary">
              Ridik keeps no audio. These transcripts are the only record of what you said, they
              never leave this phone, and deleting them here deletes them for good.
            </Txt>
            <Button
              label="Delete all history"
              icon="trash-outline"
              variant="danger"
              size="sm"
              loading={clear.isPending}
              onPress={askToClear}
            />
          </Card>
        </Section>
      ) : null}

      {confirm.dialog}
    </View>
  );
}

/* --------------------------------------------------------------- the header */

function StatsCard({ stats }: { stats: NonNullable<ReturnType<typeof useInteractionStats>['data']> }) {
  const { spacing } = useTheme();
  const p95 = formatLatency(stats.p95LatencyMs);

  /*
   * The tail belongs in a sentence, not in a stat's sub-label.
   *
   * "TYPICAL · 2.1 s" under a median of 0.9 s is two numbers with no stated
   * relationship — the reader has to guess which one is which. Nearest-rank
   * means 95% of turns came back at or under it, so that is what it says.
   */
  const line = [
    stats.actionsPerTurn === null
      ? null
      : `${stats.actionsPerTurn} ${stats.actionsPerTurn === 1 ? 'action' : 'actions'} per turn`,
    p95 ? `95% under ${p95}` : null,
    stats.models.length > 0 ? stats.models.map((entry) => entry.model).join(', ') : null,
  ].filter((part): part is string => part !== null);

  return (
    <Card style={{ gap: spacing.sm }}>
      <View style={styles.summaryRow}>
        <Stat value={String(stats.total)} label="turns" />
        <Stat value={formatLatency(stats.medianLatencyMs) ?? '—'} label="typical reply" />
        <Stat
          value={stats.errors > 0 ? String(stats.errors) : '—'}
          label="failed"
          detail={stats.clarify > 0 ? `${stats.clarify} asked` : undefined}
        />
      </View>
      {line.length > 0 ? (
        <Txt variant="micro" tone="tertiary">
          {line.join(' · ')}
        </Txt>
      ) : null}
    </Card>
  );
}

function Stat({ value, label, detail }: { value: string; label: string; detail?: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Txt variant="heading" numberOfLines={1}>
        {value}
      </Txt>
      {/* No `numberOfLines`: Android does not count `letterSpacing` when it
          measures a line, so a tracked label capped at one line ellipsises a
          character early. It wraps instead. */}
      <Txt variant="micro" tone="tertiary" style={styles.tracked}>
        {label.toUpperCase()}
        {detail ? ` · ${detail}` : ''}
      </Txt>
    </View>
  );
}

/* ------------------------------------------------------------------ a turn */

function TurnRow({
  turn,
  zone,
  expanded,
  onToggle,
  onForget,
}: {
  turn: Interaction;
  zone: string;
  expanded: boolean;
  onToggle: () => void;
  onForget: () => void;
}) {
  const { colors, spacing } = useTheme();
  const press = usePressScale({ scale: 0.99 });
  const status = STATUS[turn.status];
  const tint =
    turn.status === 'error' ? colors.danger : turn.status === 'clarify' ? colors.warning : colors.success;
  const latency = formatLatency(turn.latencyMs);

  const meta = [
    turn.parsedActions.length > 0 ? countLabel(turn.parsedActions.length, 'action') : null,
    turn.model,
    latency,
  ].filter((part): part is string => Boolean(part));

  return (
    <View>
      <AnimatedPressable
        accessibilityRole="button"
        // The outcome is announced, not left to the icon. A dot of colour is
        // the whole difference between a turn that worked and one that failed,
        // and a screen reader hears none of it.
        accessibilityLabel={`${turn.transcript}, ${status.label.toLowerCase()}`}
        accessibilityHint={expanded ? 'Tap to collapse' : 'Tap for the full transcript'}
        accessibilityState={{ expanded }}
        onPress={onToggle}
        {...press.handlers}
        style={[styles.turnRow, { paddingHorizontal: spacing.md }, press.style]}
      >
        <Ionicons name={status.icon} size={17} color={tint} style={styles.statusIcon} />
        <View style={{ flex: 1, gap: 3 }}>
          <Txt variant="body" numberOfLines={expanded ? undefined : 2}>
            {turn.transcript}
          </Txt>
          <View style={styles.meta}>
            <Txt variant="micro" tone="tertiary">
              {formatTime(turn.createdAt, zone)}
            </Txt>
            {meta.map((part, index) => (
              <Txt key={`${index}-${part}`} variant="micro" tone="tertiary">
                · {part}
              </Txt>
            ))}
          </View>
        </View>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={15}
          color={colors.textTertiary}
        />
      </AnimatedPressable>
      {expanded ? <TurnDetail turn={turn} onForget={onForget} /> : null}
    </View>
  );
}

function TurnDetail({ turn, onForget }: { turn: Interaction; onForget: () => void }) {
  const { colors, radius, spacing } = useTheme();
  const toast = useToast();

  const copy = () => {
    void copyToClipboard(turn.transcript).then((result) =>
      toast.show(
        result.ok
          ? { message: 'Transcript copied', tone: 'success' }
          : { message: result.error.userMessage, tone: 'danger' },
      ),
    );
  };

  return (
    <View style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.md, gap: spacing.md }}>
      <View style={{ gap: 4 }}>
        <Txt variant="eyebrow" tone="tertiary">
          HEARD
        </Txt>
        {/* Selectable, and the exact words. This is the record — a person
            checking what they said needs to be able to lift it out. */}
        <Txt variant="body" selectable>
          {turn.transcript}
        </Txt>
      </View>

      {turn.feedback ? (
        <View style={{ gap: 4 }}>
          <Txt variant="eyebrow" tone="tertiary">
            SAID BACK
          </Txt>
          <Txt variant="body" tone="secondary" selectable>
            {turn.feedback}
          </Txt>
        </View>
      ) : null}

      <View style={{ gap: 4 }}>
        <Txt variant="eyebrow" tone="tertiary">
          {turn.parsedActions.length > 0 ? 'WROTE' : 'WROTE NOTHING'}
        </Txt>
        {turn.parsedActions.length === 0 ? (
          <Txt variant="caption" tone="tertiary">
            {turn.status === 'error'
              ? 'Nothing was changed — the turn failed before it could act.'
              : 'This turn changed nothing.'}
          </Txt>
        ) : (
          <View
            style={{
              gap: spacing.sm,
              backgroundColor: colors.surfaceSunken,
              borderRadius: radius.sm,
              padding: spacing.sm,
            }}
          >
            {turn.parsedActions.map((action, index) => (
              <ActionBlock key={`${action.toolName}-${index}`} action={action} />
            ))}
          </View>
        )}
      </View>

      {turn.error ? (
        <View style={{ gap: 4 }}>
          <Txt variant="eyebrow" tone="tertiary">
            WENT WRONG
          </Txt>
          <Txt variant="caption" tone="danger" selectable>
            {turn.error}
          </Txt>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Button label="Copy transcript" icon="copy-outline" size="sm" onPress={copy} />
        <Button
          label="Forget this turn"
          icon="trash-outline"
          size="sm"
          variant="ghost"
          onPress={onForget}
        />
      </View>
    </View>
  );
}

/**
 * One tool call, with the parameters it was actually given.
 *
 * The parameters are the point. A summary reads "Added 1 item" whichever list
 * it went to; only `list_name` says whether the milk is on the shopping list or
 * on Hardware, and a mis-heard word shows up nowhere else.
 */
function ActionBlock({ action }: { action: InteractionAction }) {
  const { colors } = useTheme();
  const entries = Object.entries(action.parameters ?? {});

  return (
    <View style={{ gap: 3 }}>
      <View style={styles.actionHead}>
        <Ionicons
          name={action.ok ? 'checkmark' : 'close'}
          size={13}
          color={action.ok ? colors.success : colors.danger}
        />
        <Txt variant="mono" style={{ flex: 1 }} numberOfLines={1}>
          {action.toolName}
        </Txt>
      </View>
      {action.summary ? (
        <Txt variant="caption" tone="secondary">
          {action.summary}
        </Txt>
      ) : null}
      {action.asked ? (
        <Txt variant="caption" tone="warning">
          Asked: {action.asked}
        </Txt>
      ) : null}
      {action.error ? (
        <Txt variant="caption" tone="danger">
          {action.error}
        </Txt>
      ) : null}
      {entries.map(([key, value]) => (
        <View key={key} style={styles.parameter}>
          {/* `flex` on both, never content-sized: Android measures a text in a
              flex row short and clips it rather than wrapping. */}
          <Txt variant="micro" tone="tertiary" style={styles.parameterKey} numberOfLines={1}>
            {key}
          </Txt>
          <Txt variant="micro" style={{ flex: 1 }} selectable>
            {formatParameter(value)}
          </Txt>
        </View>
      ))}
    </View>
  );
}

/* ---------------------------------------------------------------- plumbing */

type DayBucket = { date: LocalDate; at: number; turns: Interaction[] };

/**
 * Buckets by the local day a turn happened on.
 *
 * On the local date rather than an epoch range, for the same reason the
 * activity feed does: a 23-hour DST day is still one day to the person who
 * lived it. The input is already newest-first, so the buckets come out in that
 * order without a sort.
 */
export function groupByDay(turns: readonly Interaction[], zone: string): DayBucket[] {
  const buckets: DayBucket[] = [];
  for (const turn of turns) {
    const date = localDateOf(turn.createdAt, zone);
    const last = buckets[buckets.length - 1];
    if (last && last.date === date) last.turns.push(turn);
    else buckets.push({ date, at: turn.createdAt, turns: [turn] });
  }
  return buckets;
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
              { width: `${74 - i * 8}%`, height: 11, backgroundColor: colors.surfaceRaised },
            ]}
          />
          <View
            style={[styles.bone, { width: '32%', height: 8, backgroundColor: colors.surfaceSunken }]}
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
  turnRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingVertical: 10 },
  statusIcon: { marginTop: 1 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  actionHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  parameter: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  parameterKey: { flex: 0.5 },
  bone: { borderRadius: 4 },
});
