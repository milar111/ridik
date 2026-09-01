/**
 * What Ridik counts about itself, shown to the person it counted.
 *
 * This is a **disclosure surface**, not a dashboard. Its whole purpose is that
 * what you read here is exactly what would be uploaded if sending were ever
 * switched on — same rows, same words, nothing summarised on the way past and
 * nothing held back. A privacy promise that can only be checked by reading the
 * source is a promise made to people who can read the source.
 *
 * Three things follow from that and are easy to undo by accident:
 *
 *  - **Every number is reachable as text.** The bars are proportion, not
 *    information; the count beside each one is the information. A figure that
 *    exists only as a width is a figure a screen reader cannot report, and this
 *    is the screen where "you can see for yourself" is the entire argument.
 *  - **The empty rows are the point.** The vocabulary is listed in full from
 *    `EVENT_NAMES`, including the eight kinds that have never happened on this
 *    install, because "these eleven things and nothing else" is a stronger
 *    statement than a list of whatever happens to be non-zero today.
 *  - **Export writes the upload, to a file.** `usageExportDocument()` emits
 *    `UploadableEvent` — no row id, no timestamp finer than a day — through the
 *    same share sheet every other export uses. That is how the operator gets a
 *    real answer out of a beta tester with no network involved at all.
 *
 * The reply-time row is the one thing here that is *not* from this ledger: it
 * comes from `llm_interactions`, where a turn's real duration is recorded, and
 * it says so. The buckets above it are all the ledger is allowed to know.
 *
 * Reachable from the menu. Home stays one screen.
 */
import { StyleSheet, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { countLabel, formatLatency } from '@/core/format';
import { toAppError } from '@/core/result';
import { currentZone, formatDayHeading, localToEpoch, type LocalDate } from '@/core/time';
import {
  LATENCY_TARGET_P95_MS,
  RETAIN_DAYS,
  RETAIN_ROWS,
  useClearUsageLedger,
  useSetting,
  useTurnLatency,
  useUsageOverview,
  type EventCount,
  type LatencySummary,
  type UsageOverview,
} from '@/hooks';
// By path, not through the barrel: this one loads the filesystem and the share
// sheet, and the barrel is imported by every screen in the app.
import { useExportUsage } from '@/hooks/useUsageExport';
// The recipient, named where the claim about it is made. `consent.ts` owns the
// words for every outbound path and is why they cannot drift apart.
import { ANALYTICS_PROVIDER } from '@/llm/consent';
// The module rather than `@/services/analytics`, whose index pulls the writer
// and the repositories in behind it. These two are plain constants.
import { EVENT_NAMES, LATENCY_BUCKETS } from '@/services/analytics/events';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useAnnounceOnIOS } from '@/ui/a11y';
import { useTheme } from '@/ui/ThemeProvider';
import { Button, Card, Divider, EmptyState, Screen, Section, Txt, useConfirm, useToast } from '@/ui/components';
import { REFLOW_MS } from '@/ui/motion';
import { useStaggeredEntry } from '@/ui/motionHooks';

function reason(error: unknown): string {
  return toAppError(error).userMessage;
}

/**
 * The enum values, in English — one small map per breakdown, never one shared.
 *
 * A single map across the screen was tried and is wrong: `offline` is a value
 * of `turn.mode` *and* an `AppErrorCode`, so one map turns a failure reason into
 * "Offline matching" and quietly misreports why turns broke. These are separate
 * closed sets that happen to share words, and they stay separate.
 */
const STEP: Record<string, string> = { consent: 'The consent screen', first_word: 'The first word' };
const OUTCOME: Record<string, string> = {
  allow: 'Allowed',
  decline: 'Declined',
  carry_on: 'Carried on',
  not_now: 'Not now',
};
const SOURCE: Record<string, string> = { chip: 'A suggestion', voice: 'Spoken', typed: 'Typed' };
/** `first_word.ok` is a bit, and "1" is not a word anybody reads. */
const LANDED: Record<string, string> = { '1': 'Landed', '0': 'Did not land' };
const STATUS: Record<string, string> = { ok: 'Done', clarify: 'Asked back', error: 'Failed' };
const MODE: Record<string, string> = { model: 'The model answered', offline: 'Offline matching' };

/**
 * A value as a person reads it.
 *
 * Anything with no entry keeps itself with the underscores taken out, so a
 * value added to the vocabulary tomorrow reads as "low confidence" rather than
 * disappearing. `'null'` is the one global case because the query produces it —
 * `json_extract` coalesces a missing property to that string — rather than the
 * vocabulary containing it.
 */
export function readable(value: string, labels?: Record<string, string>): string {
  if (labels?.[value]) return labels[value];
  if (value === 'null') return 'Not recorded';
  return value.replace(/_/g, ' ');
}

/**
 * Puts a breakdown back into its declared order.
 *
 * `countsByProp` answers most-frequent-first, which is right for the tool table
 * and wrong for the latency buckets: "2-4s, <1s, 8s+" is a histogram with its
 * axis shuffled, and the one question buckets exist to answer — is the shape
 * moving right? — cannot be read off it. Anything not in `order` keeps its place
 * at the end rather than being dropped.
 */
export function inDeclaredOrder(
  entries: readonly EventCount[],
  order: readonly string[],
): EventCount[] {
  const rank = new Map(order.map((name, index) => [name, index]));
  return [...entries].sort(
    (a, b) => (rank.get(a.name) ?? order.length) - (rank.get(b.name) ?? order.length),
  );
}

/** Every name in the vocabulary, with the count this install has for it. */
export function vocabularyCounts(byName: readonly EventCount[]): EventCount[] {
  const held = new Map(byName.map((entry) => [entry.name, entry.count]));
  const known = EVENT_NAMES.map((name) => ({ name, count: held.get(name) ?? 0 }));
  // A row whose name is not in the union should be impossible — `track()`
  // refuses one — but if a build ever wrote one, hiding it here would be this
  // screen lying about its own contents.
  const strays = byName.filter((entry) => !(EVENT_NAMES as readonly string[]).includes(entry.name));
  return [...known, ...strays];
}

export default function UsageScreen() {
  return (
    <Screen back title="Usage" subtitle="Ridik’s own count of how you use it">
      <ErrorBoundary label="usage">
        <UsageBody />
      </ErrorBoundary>
    </Screen>
  );
}

function UsageBody() {
  const { spacing } = useTheme();
  const zone = currentZone();
  const toast = useToast();
  const confirm = useConfirm();

  /* Every hook above every return. Half the screens in this app return a
     skeleton while a query is in flight, and a `use…()` below that return runs
     on the second render and not the first. */
  const overview = useUsageOverview();
  const latency = useTurnLatency();
  const clear = useClearUsageLedger();
  const exportUsage = useExportUsage();
  const arrive = useStaggeredEntry({ from: 'below' });

  const data = overview.data;
  const rows = data?.totals.rows ?? 0;
  const sent = data ? data.totals.rows - data.totals.unsent : 0;

  /* The headline appears with news on it, so it is announced. The Android half
     is the live region on the card itself; this is the iOS half, and doing both
     on both platforms is how a sentence gets said twice. */
  useAnnounceOnIOS(
    data
      ? `${countLabel(rows, 'row')} counted on this phone, ${sent === 0 ? 'none sent' : `${sent} sent`}.`
      : null,
  );

  if (overview.isError) {
    return <RetryRow message={reason(overview.error)} onRetry={() => void overview.refetch()} />;
  }

  const askToClear = () => {
    confirm.ask({
      title: 'Delete everything counted?',
      message:
        `${countLabel(rows, 'row')} go. Nothing else does — your notes, tasks, events, ` +
        'transcripts and habits are untouched, and Ridik starts counting again from zero.',
      confirmLabel: 'Delete all',
      onConfirm: () =>
        clear.mutate(undefined, {
          onSuccess: () => toast.show({ message: 'Usage deleted', tone: 'neutral' }),
          onError: (error) =>
            toast.show({ message: 'Could not clear that', detail: reason(error), tone: 'danger' }),
        }),
    });
  };

  const doExport = () => {
    exportUsage.mutate(undefined, {
      onSuccess: (outcome) =>
        toast.show({
          message: outcome.shared ? 'Usage exported' : 'Usage written to a file',
          tone: 'success',
        }),
      onError: (error) =>
        toast.show({ message: 'Could not export that', detail: reason(error), tone: 'danger' }),
    });
  };

  const sections: { key: string; node: React.ReactNode }[] = data
    ? buildSections(data, zone)
    : [];

  return (
    <View style={{ gap: spacing.lg }}>
      <Disclosure />

      {!data ? (
        <SkeletonRows />
      ) : rows === 0 ? (
        <EmptyState
          icon="bar-chart-outline"
          title="Nothing has been counted yet"
          hint={
            'Ridik counts that something happened — a turn, a screen, a permission — ' +
            'never what it was about. The moment there is anything to show, it appears ' +
            'here first and goes nowhere else.'
          }
        />
      ) : (
        <>
          <Totals rows={rows} sent={sent} />

          {sections.map((section, index) => (
            <Animated.View
              key={section.key}
              entering={arrive(index)}
              layout={LinearTransition.duration(REFLOW_MS)}
            >
              {section.node}
            </Animated.View>
          ))}

          <ReplyTime latency={latency.data} />

          <Section title="This record">
            <Card style={{ gap: spacing.sm }}>
              <Txt variant="caption" tone="secondary">
                The export is the upload, written to a file instead: the same rows, without the
                row ids and without any time finer than the day. Send it to whoever asked for it,
                or read it yourself.
              </Txt>
              <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
                <Button
                  label="Export usage"
                  icon="share-outline"
                  size="sm"
                  loading={exportUsage.isPending}
                  onPress={doExport}
                />
                <Button
                  label="Delete everything counted"
                  icon="trash-outline"
                  variant="danger"
                  size="sm"
                  loading={clear.isPending}
                  onPress={askToClear}
                />
              </View>
            </Card>
          </Section>
        </>
      )}

      {confirm.dialog}
    </View>
  );
}

/**
 * The sections, built as data so the entry stagger has something to index and
 * so an empty one can be dropped rather than drawn as a heading over nothing.
 */
function buildSections(data: UsageOverview, zone: string): { key: string; node: React.ReactNode }[] {
  const sections: { key: string; node: React.ReactNode }[] = [
    {
      key: 'vocabulary',
      node: (
        <Section title="Every kind of row">
          <Breakdown
            entries={vocabularyCounts(data.byName)}
            caption="The whole vocabulary, including what has never happened here. Nothing outside this list can be written."
          />
        </Section>
      ),
    },
  ];

  const funnel = [
    { key: 'step', title: 'Which gate', entries: data.firstRunStep, labels: STEP },
    { key: 'outcome', title: 'Which way it went', entries: data.firstRunOutcome, labels: OUTCOME },
    {
      key: 'source',
      title: 'How the first word was started',
      entries: data.firstWordSource,
      labels: SOURCE,
    },
    { key: 'ok', title: 'Whether it landed', entries: data.firstWordOk, labels: LANDED },
  ].filter((part) => part.entries.length > 0);

  if (funnel.length > 0) {
    sections.push({
      key: 'funnel',
      node: (
        <Section title="The first utterance">
          <Card style={{ gap: 14 }}>
            <Txt variant="caption" tone="secondary">
              The two gates of the first run, and whether the first thing you said reached
              anything.
            </Txt>
            {funnel.map((part, index) => (
              <View key={part.key} style={{ gap: 8 }}>
                {index > 0 ? <Divider /> : null}
                <Txt variant="eyebrow" tone="tertiary">
                  {part.title.toUpperCase()}
                </Txt>
                <Bars entries={part.entries} labels={part.labels} />
              </View>
            ))}
          </Card>
        </Section>
      ),
    });
  }

  const turns = [
    { key: 'status', title: 'How it ended', entries: data.turnStatus, labels: STATUS },
    { key: 'mode', title: 'What answered', entries: data.turnMode, labels: MODE },
    { key: 'input', title: 'How it arrived', entries: data.turnInput, labels: SOURCE },
    {
      key: 'latency',
      title: 'How long it took',
      entries: inDeclaredOrder(data.turnLatency, LATENCY_BUCKETS),
      labels: undefined,
    },
  ].filter((part) => part.entries.length > 0);

  if (turns.length > 0) {
    sections.push({
      key: 'turns',
      node: (
        <Section title="Turns">
          <Card style={{ gap: 14 }}>
            <Txt variant="caption" tone="secondary">
              One row per utterance. The duration is a bucket, never a number — a millisecond
              figure per turn is a timeline of somebody’s day once you have a few hundred.
            </Txt>
            {turns.map((part, index) => (
              <View key={part.key} style={{ gap: 8 }}>
                {index > 0 ? <Divider /> : null}
                <Txt variant="eyebrow" tone="tertiary">
                  {part.title.toUpperCase()}
                </Txt>
                <Bars entries={part.entries} labels={part.labels} />
              </View>
            ))}
          </Card>
        </Section>
      ),
    });
  }

  if (data.tools.length > 0) {
    sections.push({
      key: 'tools',
      node: (
        <Section title="Tools">
          <Breakdown
            entries={data.tools}
            mono
            caption="Which tools carry the app and which are dead weight. Most used first."
          />
        </Section>
      ),
    });
  }

  if (data.failures.length > 0) {
    sections.push({
      key: 'failures',
      node: (
        <Section title="Failures">
          <Breakdown
            entries={data.failures}
            caption="Why turns failed, from Ridik’s own closed set of reasons. No message, no detail — the code and nothing else."
          />
        </Section>
      ),
    });
  }

  if (data.byDay.length > 0) {
    sections.push({
      key: 'days',
      node: (
        <Section title="By day">
          <Breakdown
            entries={data.byDay.map((day) => ({
              name: dayLabel(day.localDate, zone),
              count: day.count,
            }))}
            caption={`The local day is the finest time anything here is stamped with. ${countLabel(
              data.byDay.length,
              'day',
            )} held.`}
          />
        </Section>
      ),
    });
  }

  return sections;
}

function dayLabel(date: LocalDate, zone: string): string {
  return formatDayHeading(localToEpoch(date, zone), zone);
}

/* ---------------------------------------------------------------- the pitch */

/**
 * The claim, in whichever of the two states it is actually true.
 *
 * The switch on Settings can be on, and a page that says "this never leaves the
 * phone" while it is would be the one lie this screen exists to make impossible
 * — so the sentence is read off `analyticsOptIn` rather than assumed. It says
 * *the switch is on*, not *this has been sent*: consent gates the upload as
 * well, and claiming more sending than happens is the safe direction for a
 * disclosure to be wrong in.
 */
function Disclosure() {
  const { spacing } = useTheme();
  const optIn = useSetting('analyticsOptIn');

  return (
    <Card style={{ gap: spacing.sm }}>
      <Txt variant="caption" tone="secondary">
        This is Ridik’s own count of how you use it: that a turn happened, whether it worked,
        roughly how long it took, which screen you opened.{' '}
        {optIn.value
          ? `Sending is switched on, so these rows go to ${ANALYTICS_PROVIDER} in batches. Turning it off in Settings stops the next one; anything already sent cannot be recalled.`
          : 'It is written to this phone and nowhere else, and it is not sent anywhere unless you switch that on in Settings.'}
      </Txt>
      <Txt variant="caption" tone="secondary">
        Nothing you said, typed or saved is in it. Every value below comes from a fixed list of
        words the app is allowed to write down, so there is no room in the shape for a note, a
        name or a place — which is what makes this page a disclosure rather than a summary. What
        you read here is exactly what would be sent.
      </Txt>
    </Card>
  );
}

function Totals({ rows, sent }: { rows: number; sent: number }) {
  const { spacing } = useTheme();
  return (
    <Card
      style={{ gap: spacing.sm }}
      // The Android half of the pair; `useAnnounceOnIOS` upstairs is the other.
      accessibilityLiveRegion="polite"
    >
      <View style={styles.summaryRow}>
        <Stat value={rows.toLocaleString('en-GB')} label="rows held" />
        <Stat
          value={sent === 0 ? 'None' : sent.toLocaleString('en-GB')}
          label={sent === 0 ? 'ever sent' : 'sent'}
        />
      </View>
      <Txt variant="micro" tone="tertiary">
        Ridik keeps {RETAIN_DAYS} days or {RETAIN_ROWS.toLocaleString('en-GB')} rows, whichever is
        newer. Anything past that is dropped as the next row is written, so this never grows.
      </Txt>
    </Card>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
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
      </Txt>
    </View>
  );
}

/* ------------------------------------------------------------------- a strip */

function Breakdown({
  entries,
  caption,
  labels,
  mono,
}: {
  entries: readonly EventCount[];
  caption?: string;
  labels?: Record<string, string>;
  /** The rows are identifiers: set in the mono and left exactly as written. */
  mono?: boolean;
}) {
  const { spacing } = useTheme();
  return (
    <Card style={{ gap: spacing.sm }}>
      {caption ? (
        <Txt variant="caption" tone="secondary">
          {caption}
        </Txt>
      ) : null}
      <Bars entries={entries} labels={labels} mono={mono} />
    </Card>
  );
}

function Bars({
  entries,
  labels,
  mono,
}: {
  entries: readonly EventCount[];
  labels?: Record<string, string>;
  /**
   * The rows are identifiers — a `ToolName`, not a word. Set in the mono and
   * left verbatim: "checklist add" is not the name of anything, and this table
   * is read against the tool list in the contract.
   */
  mono?: boolean;
}) {
  const { colors } = useTheme();
  const max = entries.reduce((top, entry) => Math.max(top, entry.count), 0);

  return (
    <View style={{ gap: 9 }}>
      {entries.map((entry) => {
        const label = mono ? entry.name : readable(entry.name, labels);
        // A sliver rather than nothing: a row that happened once and a row that
        // never happened must not draw the same width.
        const width = max === 0 ? 0 : Math.max(2, Math.round((entry.count / max) * 100));
        return (
          <View
            key={entry.name}
            style={{ gap: 4 }}
            // One element, one sentence. Without this the reader stops on the
            // label and then again on the number with nothing joining them, and
            // the bar — which is the only thing that relates them visually — is
            // not an accessibility element at all.
            accessible
            accessibilityRole="text"
            accessibilityLabel={`${label}, ${entry.count}`}
          >
            <View style={styles.spread}>
              {/* `flex: 1`, never content-sized: Android measures a text in a
                  flex row short and clips it rather than wrapping. */}
              <Txt
                variant={mono ? 'mono' : 'caption'}
                tone={entry.count === 0 ? 'tertiary' : 'primary'}
                style={{ flex: 1 }}
                numberOfLines={1}
              >
                {label}
              </Txt>
              <Txt variant="caption" tone={entry.count === 0 ? 'tertiary' : 'secondary'}>
                {entry.count.toLocaleString('en-GB')}
              </Txt>
            </View>
            <View style={[styles.track, { backgroundColor: colors.surfaceSunken }]}>
              {/* `accent`, not `heat.core`: a 5pt rule is not the large fill the
                  vivid ember is reserved for, and this one sits beside text. */}
              <View
                style={[styles.fill, { width: `${width}%`, backgroundColor: colors.accent }]}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

/* --------------------------------------------------------------- reply time */

/**
 * The one figure here that is not from this ledger, and it says so.
 *
 * `latency_ms` on `llm_interactions` is the real duration of a turn; the ledger
 * only ever sees the bucket. Both belong on this page — the buckets are what
 * would be *sent*, and this is what the phone actually knows — but conflating
 * them would make the disclosure above untrue.
 */
function ReplyTime({ latency }: { latency: LatencySummary | undefined }) {
  const { colors, spacing } = useTheme();
  if (!latency || latency.timed === 0) return null;

  const target = formatLatency(LATENCY_TARGET_P95_MS) ?? '—';
  const slow = latency.withinTarget === false;

  return (
    <Section title="Reply time">
      <Card style={{ gap: spacing.xs, borderColor: slow ? colors.warning : colors.border }}>
        <Txt variant="bodyStrong" tone={slow ? 'warning' : 'primary'}>
          {formatLatency(latency.medianMs) ?? '—'} typical · 95% under{' '}
          {formatLatency(latency.p95Ms) ?? '—'}
        </Txt>
        <Txt variant="caption" tone="secondary">
          Over the last {countLabel(latency.timed, 'timed turn')} of {latency.turns}. The slow tail
          is {slow ? 'past' : 'inside'} the {target} it is held to.
        </Txt>
        <Txt variant="micro" tone="tertiary">
          Measured from Ridik’s own record of each turn, on this phone. Only the bucket above ever
          leaves it.
        </Txt>
      </Card>
    </Section>
  );
}

/* ---------------------------------------------------------------- plumbing */

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
    <Card style={{ gap: spacing.md }}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={{ gap: 6 }}>
          <View
            style={[
              styles.bone,
              { width: `${68 - i * 7}%`, height: 10, backgroundColor: colors.surfaceRaised },
            ]}
          />
          <View style={[styles.bone, { width: '100%', height: 5, backgroundColor: colors.surfaceSunken }]} />
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  tracked: { letterSpacing: 0.8 },
  summaryRow: { flexDirection: 'row', gap: 12 },
  track: { height: 5, borderRadius: 3, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
  bone: { borderRadius: 4 },
});
