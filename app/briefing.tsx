import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { type EntryOrExitLayoutType } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { countLabel } from '@/core/format';
import {
  clockColumnWidth,
  formatClock,
  formatDayHeading,
  formatDuration,
  formatTime,
} from '@/core/time';
import type {
  BriefingCommitment,
  BriefingData,
  BriefingIcon,
  BriefingTask,
} from '@/features/briefing';
import { briefingMarkdown, shareAsFile } from '@/features/export';
import { useBriefing, useBriefingSpeech, type BriefingScope } from '@/hooks/useBriefing';
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  Screen,
  Section,
  Segmented,
  Txt,
  useToast,
} from '@/ui/components';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useStaggeredEntry , AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import { useTheme } from '@/ui/ThemeProvider';

const SCOPES: { value: BriefingScope; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'week', label: 'This week' },
];

const VOICE_HINT = "Try: 'add football practice on Tuesday at six' — then ask me for your briefing.";

export default function BriefingScreen() {
  const router = useRouter();
  const [scope, setScope] = useState<BriefingScope>('today');

  const close = useCallback(() => {
    // The modal is the only screen the user can be on and not see a tab bar, so
    // it must always have a way out even when it was opened deep-linked.
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  return (
    <Screen title="Briefing" right={<CloseButton onPress={close} />}>
      <Segmented options={SCOPES} value={scope} onChange={setScope} />
      <ErrorBoundary
        label="briefing"
        fallback={(error, reset) => <InlineError message={error.message} onRetry={reset} />}
      >
        <BriefingBody scope={scope} onNavigate={close} />
      </ErrorBoundary>
    </Screen>
  );
}

function CloseButton({ onPress }: { onPress: () => void }) {
  const { colors, radius } = useTheme();
  // A small filled disc: there is a fill to watch it move, so the default is
  // enough travel.
  const press = usePressScale();
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel="Close briefing"
      onPress={onPress}
      hitSlop={10}
      {...press.handlers}
      style={[
        styles.close,
        { backgroundColor: colors.surfaceRaised, borderRadius: radius.pill },
        press.style,
      ]}
    >
      <Ionicons name="close" size={18} color={colors.textSecondary} />
    </AnimatedPressable>
  );
}

function BriefingBody({ scope, onNavigate }: { scope: BriefingScope; onNavigate: () => void }) {
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const router = useRouter();

  const query = useBriefing(scope);
  const speech = useBriefingSpeech();
  // Changing scope replaces every bullet, and the bullets are keyed by index —
  // so they do not remount and the wave plays once, when the briefing first
  // lands. That is the correct reading: this is a page being read to you, and
  // it should not re-assemble itself every time you tap Tomorrow.
  const arrive = useStaggeredEntry({ from: 'below' });

  const briefing = query.data;

  const go = (href: string) => {
    onNavigate();
    router.push(href as never);
  };

  // Pressing Play *is* the answer to "shall I speak?", so it never consults
  // `ttsEnabled` — and never writes it either. That switch governs speech the
  // user did not ask for (`pipeline.speak`), and one press here must not sign
  // them up for spoken replies everywhere else. `speakBriefing` bypasses it.
  const play = () => {
    if (speech.isSpeaking) speech.stop();
    else speech.play(scope);
  };

  const share = async () => {
    if (!briefing) return;
    const result = await shareAsFile(
      briefingMarkdown(briefing.data),
      `briefing-${briefing.data.date}.md`,
      { dialogTitle: 'Share briefing' },
    );
    if (!result.ok) toast.show({ message: result.error.userMessage, tone: 'danger' });
  };

  if (query.isError) {
    return (
      <Card padded={false}>
        <InlineError
          message={query.error?.message ?? 'I could not put your briefing together.'}
          onRetry={() => void query.refetch()}
        />
      </Card>
    );
  }

  if (!briefing) return <BulletSkeleton />;

  const data = briefing.data;

  return (
    <>
      <Card>
        <View style={{ gap: spacing.md }}>
          {briefing.bullets.map((bullet, index) => (
            <Animated.View key={index} entering={arrive(index)} style={styles.bullet}>
              <Ionicons
                name={ICONS[bullet.icon]}
                size={20}
                color={bulletColor(colors, bullet.icon)}
                style={{ marginTop: 1 }}
              />
              <Txt variant="heading" weight="500" style={{ flex: 1 }}>
                {bullet.text}
              </Txt>
            </Animated.View>
          ))}

          <Divider />

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Button
              label={speech.isSpeaking ? 'Stop' : 'Play'}
              icon={speech.isSpeaking ? 'stop' : 'volume-high'}
              variant={speech.isSpeaking ? 'danger' : 'primary'}
              onPress={play}
              accessibilityLabel={speech.isSpeaking ? 'Stop speaking' : 'Play the spoken briefing'}
            />
            <Txt variant="caption" tone={speech.isSpeaking ? 'accent' : 'tertiary'}>
              {speech.isSpeaking ? 'Speaking…' : '~15 seconds'}
            </Txt>
            <View style={{ flex: 1 }} />
            <Button
              icon="share-outline"
              size="sm"
              onPress={() => void share()}
              accessibilityLabel="Share the briefing"
            />
          </View>

          {data.unsyncedCount > 0 ? (
            <Badge label={`${countLabel(data.unsyncedCount, 'change')} not synced`} tone="warning" />
          ) : null}
        </View>
      </Card>

      <Detail data={data} onOpen={go} />
    </>
  );
}

/* ---------------------------------------------------------------- detail -- */

function Detail({ data, onOpen }: { data: BriefingData; onOpen: (href: string) => void }) {
  const arrive = useStaggeredEntry({ from: 'below' });
  // Eight sections, one wave. `rank` is a plain counter rather than eight
  // separate hooks because the detail is *one* list broken by heading — a
  // per-section count would have Streaks arriving as slowly as Classes did,
  // eight times over, which reads as eight lists loading rather than one page.
  // Reset on every render by construction, so it cannot drift.
  let rank = 0;

  const timed = data.events.filter((event) => !event.isBuffer);
  const buffers = data.events.filter((event) => event.isBuffer);
  const due = [...data.overdueTasks, ...data.dueTasks, ...data.upcomingTasks];
  const overdue = new Set(data.overdueTasks.map((task) => task.id));
  const empty =
    timed.length === 0 &&
    buffers.length === 0 &&
    data.classes.length === 0 &&
    due.length === 0 &&
    data.commitments.length === 0 &&
    data.streaks.length === 0 &&
    !data.focus;

  if (empty) {
    return (
      <Card>
        <EmptyState icon="cafe-outline" title="Nothing on the books" hint={VOICE_HINT} />
      </Card>
    );
  }

  return (
    <>
      {data.classes.length > 0 ? (
        <Section title="Classes">
          <Card padded={false}>
            {data.classes.map((entry, index) => (
              <Row
                key={`${entry.subject}-${entry.startsAt}`}
                entering={arrive(rank++)}
                first={index === 0}
                icon="school-outline"
                lead={formatTime(entry.startsAt, data.zone)}
                title={entry.subject}
                // The end time joins the meta rather than doubling the column:
                // "14:00–17:00" is 97pt of Martian against a 52pt slot.
                meta={
                  [`until ${formatTime(entry.endsAt, data.zone)}`, entry.location, entry.teacher]
                    .filter(Boolean)
                    .join(' · ') || null
                }
                onPress={() => onOpen('/curriculum')}
              />
            ))}
          </Card>
        </Section>
      ) : null}

      {timed.length > 0 || buffers.length > 0 ? (
        <Section title="Calendar">
          <Card padded={false}>
            {timed.map((event, index) => (
              <Row
                key={event.id}
                entering={arrive(rank++)}
                first={index === 0}
                icon="calendar-outline"
                lead={event.allDay ? null : formatTime(event.startsAt, data.zone)}
                flag={event.allDay ? 'All day' : undefined}
                title={event.title}
                meta={event.location}
                onPress={() => onOpen('/calendar')}
              />
            ))}
            {buffers.map((event) => (
              <Row
                key={event.id}
                entering={arrive(rank++)}
                icon="walk-outline"
                tone="warning"
                lead={formatTime(event.startsAt, data.zone)}
                title={event.bufferFor ? `Leave for ${event.bufferFor}` : event.title}
                meta={event.location}
                onPress={() => onOpen('/calendar')}
              />
            ))}
          </Card>
        </Section>
      ) : null}

      {due.length > 0 ? (
        <Section title="Due">
          <Card padded={false}>
            {due.map((task, index) => (
              <Row
                key={task.id}
                entering={arrive(rank++)}
                first={index === 0}
                icon={overdue.has(task.id) ? 'alert-circle-outline' : 'ellipse-outline'}
                tone={overdue.has(task.id) ? 'danger' : 'default'}
                lead={dueLead(task, data).time}
                flag={dueLead(task, data).flag}
                title={task.title}
                meta={task.estimatedMinutes ? formatDuration(task.estimatedMinutes) : null}
                onPress={() => onOpen('/tasks')}
              />
            ))}
          </Card>
        </Section>
      ) : null}

      {data.unlockedTasks.length > 0 ? (
        <Section title="Unblocked">
          <Card padded={false}>
            {data.unlockedTasks.slice(0, 5).map((task, index) => (
              <Row
                key={task.id}
                entering={arrive(rank++)}
                first={index === 0}
                icon="lock-open-outline"
                lead={null}
                flag="Ready"
                title={task.title}
                meta={null}
                onPress={() => onOpen('/tasks')}
              />
            ))}
          </Card>
        </Section>
      ) : null}

      {data.commitments.length > 0 ? (
        <Section title="Promises">
          <Card padded={false}>
            {data.commitments.map((commitment, index) => (
              <Row
                key={commitment.id}
                entering={arrive(rank++)}
                first={index === 0}
                icon={commitment.direction === 'i_owe' ? 'arrow-up-circle-outline' : 'arrow-down-circle-outline'}
                tone={commitment.isOverdue ? 'danger' : 'default'}
                lead={null}
                flag={commitment.direction === 'i_owe' ? 'You owe' : 'Owes you'}
                title={`${commitment.personName}: ${commitment.text}`}
                meta={commitmentMeta(commitment, data)}
                onPress={() => onOpen('/people')}
              />
            ))}
          </Card>
        </Section>
      ) : null}

      {data.streaks.length > 0 ? (
        <Section title="Streaks">
          <Card padded={false}>
            {data.streaks.map((habit, index) => (
              <Row
                key={habit.id}
                entering={arrive(rank++)}
                first={index === 0}
                icon="flame-outline"
                tone={habit.atRisk ? 'warning' : 'success'}
                lead={`${habit.streak}d`}
                title={habit.name}
                meta={habit.atRisk ? 'Not logged today' : null}
                onPress={() => onOpen('/habits')}
              />
            ))}
          </Card>
        </Section>
      ) : null}

      {data.focus ? (
        <Section title="Focus">
          <Card padded={false}>
            <Row
              first
              entering={arrive(rank++)}
              icon="timer-outline"
              tone="accent"
              lead={formatClock(data.focus.remainingMs)}
              title={data.focus.label}
              meta={`${data.focus.status === 'paused' ? 'Paused' : 'Running'} · ${data.focus.phase}`}
              onPress={() => onOpen('/focus')}
            />
          </Card>
        </Section>
      ) : null}
    </>
  );
}

type RowTone = 'default' | 'accent' | 'success' | 'warning' | 'danger';

function Row({
  first,
  entering,
  icon,
  tone = 'default',
  lead,
  flag,
  title,
  meta,
  onPress,
}: {
  first?: boolean;
  /**
   * The row's place in the page-wide wave, from `useStaggeredEntry`.
   *
   * Passed in rather than derived here: every section on this screen renders
   * through this component, and a row that counted its own index would restart
   * the stagger at each heading.
   */
  entering?: EntryOrExitLayoutType;
  icon: keyof typeof Ionicons.glyphMap;
  tone?: RowTone;
  /**
   * A clock reading, and only ever that — `14:00`, `01:23`, `3d`.
   *
   * The column is 52pt because `mono` is 13pt Martian and 52 is what "14:00"
   * measures plus a little. It used to take whatever each section felt like
   * putting in it, so the briefing showed `14:0…` over its classes and `Over…`
   * over its overdue tasks, and would have shown `You o…`, `Owes …`, `Somed…`
   * and `All d…` on the sections the seed does not fill. Martian is for times
   * here and on the rest of the app; a word in this column is both the wrong
   * face and 10pt too wide for it.
   */
  lead: string | null;
  /** A word that is not a time. It rides the meta line, in the row's tone. */
  flag?: string;
  title: string;
  meta: string | null;
  onPress: () => void;
}) {
  const { colors, spacing } = useTheme();
  const tint: Record<RowTone, string> = {
    default: colors.textTertiary,
    accent: colors.accent,
    success: colors.success,
    warning: colors.warning,
    danger: colors.danger,
  };

  return (
    // The divider is inside the wrapper because it belongs to the row under it:
    // left outside, a hairline would sit at full strength above a row that has
    // not arrived yet.
    <Animated.View entering={entering}>
      {first ? null : <Divider inset={spacing.md} />}
      <Card
        padded={false}
        onPress={onPress}
        style={{ borderWidth: 0, backgroundColor: 'transparent' }}
        // A row with no time must not be read out as "…, null".
        accessibilityLabel={[title, lead, flag].filter(Boolean).join(', ')}
      >
        <View style={styles.row}>
          <Ionicons name={icon} size={17} color={tint[tone]} />
          {/* Drawn even when empty: a row with no time keeps the column, so
              every title down the card starts at the same place. */}
          <Txt
            variant="mono"
            tone="tertiary"
            // Never narrower than it was, and wide enough for "12:00 AM" when
            // the clock is set to twelve hours — this column is the one
            // `AGENTS.md` records having silently truncated `Overdue` to
            // `Over…` for exactly this reason.
            style={[styles.lead, { width: Math.max(52, clockColumnWidth()) }]}
            numberOfLines={1}
          >
            {lead ?? ''}
          </Txt>
          <View style={{ flex: 1, gap: 1 }}>
            <Txt variant="body" numberOfLines={1}>
              {title}
            </Txt>
            {flag || meta ? (
              <Txt variant="caption" tone="tertiary" numberOfLines={1}>
                {flag ? <Txt style={{ color: tint[tone] }}>{flag}</Txt> : null}
                {flag && meta ? ' · ' : ''}
                {meta ?? ''}
              </Txt>
            ) : null}
          </View>
          <Ionicons name="chevron-forward" size={14} color={colors.textTertiary} />
        </View>
      </Card>
    </Animated.View>
  );
}

/* ------------------------------------------------------------------ bits -- */

function BulletSkeleton() {
  const { colors, radius, spacing } = useTheme();
  return (
    <Card>
      <View style={{ gap: spacing.md }}>
        {[0, 1, 2].map((i) => (
          <View
            key={i}
            style={{
              height: 18,
              width: `${88 - i * 14}%`,
              backgroundColor: colors.surfaceSunken,
              borderRadius: radius.sm,
            }}
          />
        ))}
      </View>
    </Card>
  );
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md }}>
      <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
      <Txt variant="caption" tone="secondary" style={{ flex: 1 }} numberOfLines={3}>
        {message}
      </Txt>
      <Button label="Retry" size="sm" onPress={onRetry} />
    </View>
  );
}

/* --------------------------------------------------------------- helpers -- */

const ICONS: Record<BriefingIcon, keyof typeof Ionicons.glyphMap> = {
  calendar: 'calendar-outline',
  travel: 'walk-outline',
  task: 'ellipse-outline',
  overdue: 'alert-circle-outline',
  streak: 'flame-outline',
  promise: 'people-outline',
  focus: 'timer-outline',
  clear: 'checkmark-circle-outline',
};

/** Colour carries the urgency of the bullet, never its category. */
function bulletColor(colors: ReturnType<typeof useTheme>['colors'], icon: BriefingIcon): string {
  switch (icon) {
    case 'overdue':
      return colors.danger;
    case 'travel':
      return colors.warning;
    case 'streak':
      return colors.success;
    case 'clear':
      return colors.textTertiary;
    default:
      return colors.accent;
  }
}

/** A time for the mono column, or a word for the meta line — never both, and
 *  never a word in the column. */
function dueLead(
  task: BriefingTask,
  data: BriefingData,
): { time: string | null; flag: string | undefined } {
  if (task.dueDate == null) return { time: null, flag: 'Someday' };
  if (task.dueDate < data.now) return { time: null, flag: 'Overdue' };
  return { time: formatTime(task.dueDate, data.zone), flag: undefined };
}

function commitmentMeta(commitment: BriefingCommitment, data: BriefingData): string | null {
  if (commitment.dueDate == null) return null;
  return `${commitment.isOverdue ? 'Was due ' : 'Due '}${formatDayHeading(
    commitment.dueDate,
    data.zone,
    data.now,
  )}`;
}

const styles = StyleSheet.create({
  close: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  bullet: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
  },
  lead: { width: 52, textAlign: 'right' },
});
