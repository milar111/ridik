/**
 * The engineering surface, reached by tapping Settings → Version seven times.
 *
 * Nothing here was deleted from the product; it was moved. These are the knobs
 * that make the app worse when set wrong — a model name that has to be spelled
 * exactly, thresholds that trade one kind of misrecognition for another, spend
 * caps that only matter on a build using your own key — plus the read-outs that
 * are only meaningful if you know what the app does internally.
 *
 * Keeping them in one place behind a deliberate gesture means the defaults stay
 * honest: nobody has to be talked out of a bad value, because nobody stumbles
 * into it.
 */
import { useMemo } from 'react';
import { View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';

import { countLabel, formatLatency } from '@/core/format';
import { formatDateTime, isValidZone } from '@/core/time';
import { copyToClipboard } from '@/features/export';
import {
  Group,
  ReserveRowLead,
  GroupSkeleton,
  RetryRow,
  Row,
  SecretRow,
  SliderRow,
  SwitchRow,
  ValidatedTextRow,
  formatBytes,
} from '@/features/settings';
import {
  LATENCY_TARGET_P95_MS,
  useAssistantUsage,
  useRebuildNoteSearchIndex,
  useSetting,
  useTurnLatency,
  type LatencySummary,
} from '@/hooks';
import { useAssistantMode } from '@/hooks/useAssistant';
import { formatCostMicros, type UsageWindow } from '@/llm/usage';
import {
  describeTrial,
  TRIAL_TOTAL_REQUESTS,
  TRIAL_TOTAL_TOKENS,
} from '@/services/billing/allowance';
import {
  useBackgroundStatus,

  useDatabaseStats,
  useLogEntries,
  usePermissions,
  useRequestPermission,
  useSecret,
  useSyncCalendarNow,
  type PermissionId,
  type PermissionLevel,
} from '@/hooks/useSystem';
import { DEFAULT_GEMINI_MODEL } from '@/llm/provider';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import { Badge, Button, Card, Screen, Section, Txt, useToast } from '@/ui/components';

export default function DeveloperScreen() {
  const router = useRouter();
  const developer = useSetting('developerMode');

  // The seven taps were the only thing standing in front of this screen, and a
  // gesture is not a gate: expo-router matches `ridik:///developer` straight to
  // it, so a deep link walked past the ritual entirely. The switch the taps set
  // is the actual state, so it is the thing to check.
  if (!developer.isLoading && !developer.value) return <Redirect href="/settings" />;

  return (
    <Screen
      title="Developer"
      subtitle="Everything the main screen deliberately hides"
      right={<Button label="Done" size="sm" onPress={() => router.back()} />}
    >
      {/* Half these cards carry icons and half do not — one reserved leading
          column so the labels share a left edge. See `ROW_LEAD`. */}
      <ReserveRowLead>
      <ErrorBoundary label="developer: assistant">
        <AssistantGroup />
      </ErrorBoundary>
      <ErrorBoundary label="developer: recognition">
        <RecognitionGroup />
      </ErrorBoundary>
      <ErrorBoundary label="developer: system">
        <SystemGroup />
      </ErrorBoundary>
      <ErrorBoundary label="developer: storage">
        <StorageGroup />
      </ErrorBoundary>
      <ErrorBoundary label="developer: diagnostics">
        <DiagnosticsGroup />
      </ErrorBoundary>

      <Group title="Leave">
        <Row
          icon="eye-off-outline"
          label="Hide developer options"
          hint="Settings goes back to normal. Seven taps on the version brings it back."
          right={
            <Button
              label="Hide"
              size="sm"
              onPress={() => {
                developer.set(false);
                router.back();
              }}
            />
          }
        />
      </Group>
      </ReserveRowLead>
    </Screen>
  );
}

/* --------------------------------------------------------------- assistant */

/**
 * What a prompt cache saved this month, and what one utterance really cost.
 *
 * A cache hit changes neither the request count nor the input count, so this
 * row is the only place the app can be *seen* to be getting one — the reason
 * `llm_usage.cached_tokens` is recorded at all. It has to be visible on the
 * hosted build in particular: the proxy is the half where caching can actually
 * pay, because it sends a byte-identical prefix on behalf of every user, and
 * for one release this read-out sat inside the branch that renders only when
 * the build is *not* hosted. The number it could have shown was therefore
 * guaranteed to be zero wherever it was drawn.
 *
 * `calls` is the same idea in the other unit: one utterance can bill the
 * provider three times when the reply has to be repaired, and nothing else in
 * the app would ever say so.
 */
function spendDetail(month: UsageWindow): string {
  const parts: string[] = [];
  if (month.inputTokens > 0 && month.cachedTokens > 0) {
    const percent = Math.round((month.cachedTokens / month.inputTokens) * 100);
    parts.push(`${percent}% of this month's input came from a prompt cache.`);
  }
  if (month.requests > 0) {
    const perTurn = (Math.max(month.calls, month.requests) / month.requests).toFixed(2);
    parts.push(`${perTurn} provider calls per request — 1.00 means nothing needed repairing.`);
  }
  return parts.join(' ');
}

/**
 * What the last hundred turns took, and whether that is good.
 *
 * `latency_ms` is written on every turn and read here. Two figures, because neither alone is honest: the
 * median is what a turn usually costs, and the 95th is what people actually
 * complain about. A mean would be neither.
 *
 * The sentence names the target. A number with nothing to compare it against
 * cannot tell anyone whether the assistant got worse, which is the only reason
 * to put it on a diagnostics screen — and judging a change to the prompt or the
 * model by feel is exactly how a regression ships.
 */
function latencyDetail(latency: LatencySummary): string {
  const target = formatLatency(LATENCY_TARGET_P95_MS) ?? '—';
  const over = `Over the last ${countLabel(latency.timed, 'timed turn')} of ${latency.turns}.`;
  if (latency.withinTarget === false) {
    const slowest = formatLatency(latency.slowestMs);
    return (
      `${over} The slow tail is past the ${target} it is held to` +
      `${slowest ? `, and the worst was ${slowest}` : ''} — long enough that people repeat ` +
      'themselves, which costs a second request and usually a second mistake.'
    );
  }
  return `${over} The slow tail is inside the ${target} it is held to.`;
}

function AssistantGroup() {
  const mode = useAssistantMode();
  const dailyCap = useSetting('llmDailyRequestCap');
  const monthlyCap = useSetting('llmMonthlyRequestCap');
  const trialUsed = useSetting('llmTrialRequestsUsed');
  // The trial's other ceiling. The request counter alone cannot say whether the
  // assistant is still on: a handful of very large turns spends the token
  // allowance while the counter still reads most of 25 left.
  const trialTokens = useSetting('llmTrialTokensUsed');
  const simulateStore = useSetting('simulateStoreBuild');
  const usage = useAssistantUsage(dailyCap.value, monthlyCap.value).data;
  const latency = useTurnLatency().data;
  const key = useSecret('llm');

  const hosted = mode.data === 'hosted';

  return (
    <Group title="Assistant">
      <Row
        icon="git-branch-outline"
        label="Mode"
        value={
          hosted
            ? 'Hosted — requests go through your backend'
            : mode.data === 'personal-key'
              ? 'Personal key on this device'
              : 'Offline — pattern matching only'
        }
        hint={hosted ? 'Model and quota are the server’s decision, not this screen’s.' : undefined}
      />

      {hosted ? null : (
        <Row
          icon="hardware-chip-outline"
          label="Model"
          value={DEFAULT_GEMINI_MODEL}
          hint="Fixed. Every price and limit in the app is worked out for this model."
        />
      )}

      {hosted ? null : (
        <SliderRow
          label="Requests per day"
          hint={
            dailyCap.value === 0
              ? 'Unlimited.'
              : `${usage?.remainingToday ?? dailyCap.value} left today${
                  usage ? ` · ${formatCostMicros(usage.today.costMicros)} so far` : ''
                }.`
          }
          value={dailyCap.value}
          min={0}
          max={1000}
          step={25}
          format={(v) => (v === 0 ? 'Off' : String(Math.round(v)))}
          onChange={(v) => dailyCap.set(Math.round(v))}
        />
      )}
      {hosted ? null : (
        <SliderRow
          label="Requests per month"
          hint={
            (monthlyCap.value === 0
              ? 'Unlimited.'
              : `${usage?.remainingThisMonth ?? monthlyCap.value} left${
                  usage ? ` · ${formatCostMicros(usage.month.costMicros)} so far` : ''
                }. Past the cap, commands fall back to pattern matching.`)
          }
          value={monthlyCap.value}
          min={0}
          max={20_000}
          step={250}
          format={(v) => (v === 0 ? 'Off' : String(Math.round(v)))}
          onChange={(v) => monthlyCap.set(Math.round(v))}
        />
      )}

      {/* The free tier's whole budget, spent once per install rather than per
          month, and read-only.

          There used to be a Reset button here. It wrote zero to the one counter
          that decides whether the operator pays for a stranger's traffic —
          one tap, unlimited repeats — and it was shown in precisely the
          configuration where the trial is the only thing standing between a
          free user and the key. A read-out is what this screen is for; the
          counter itself is monotonic by design and nothing in the app may
          lower it. */}
      <Row
        icon="hourglass-outline"
        label="Free trial"
        value={describeTrial({ requestsUsed: trialUsed.value, tokensUsed: trialTokens.value })}
        hint={`${TRIAL_TOTAL_REQUESTS} requests for the life of the install, and nothing refills them — not a date, not erasing your data, not reinstalling. There is a second ceiling under it: ${TRIAL_TOTAL_TOKENS.toLocaleString('en-GB')} tokens, of which ${Math.max(0, Math.trunc(trialTokens.value)).toLocaleString('en-GB')} are gone, and whichever runs out first ends the trial. Counted only while a store is present and nothing is subscribed.`}
      />

      {/* Outside the hosted branch on purpose: the hosted build is the one
          whose numbers here can be non-zero. */}
      {usage && spendDetail(usage.month) ? (
        <Row
          icon="speedometer-outline"
          label="This month"
          value={`${usage.month.requests} requests · ${formatCostMicros(usage.month.costMicros)}`}
          hint={spendDetail(usage.month)}
        />
      ) : null}

      {/* Beside the spend, because they are the two halves of one question: what
          a turn costs in money and what it costs in waiting. Nothing at all is
          drawn until a turn has been timed — "—" would read as an instrument
          saying zero rather than as one with nothing to measure. */}
      {latency && latency.timed > 0 ? (
        <Row
          icon="timer-outline"
          label="Reply time"
          tone={latency.withinTarget === false ? 'warning' : undefined}
          value={`${formatLatency(latency.medianMs) ?? '—'} typical · 95% under ${
            formatLatency(latency.p95Ms) ?? '—'
          }`}
          hint={latencyDetail(latency)}
        />
      ) : null}
      {hosted ? null : (
        <SwitchRow
          label="Simulate a store build"
          hint="Treats this build as though RevenueCat were compiled in, so the free-tier lock and its paywall can be walked through without store keys. Voice still falls back to offline matching."
          value={simulateStore.value}
          onChange={(next) => simulateStore.set(next)}
        />
      )}

      {/* Moved off the profile. A store build routes through the backend and
          has nothing to paste; the only person who needs this field is whoever
          is running the app against their own provider, and they can find it
          behind seven taps. */}
      {hosted ? null : (
        <SecretRow
          slot="llm"
          label="Assistant key"
          hint="Kept in the device keychain. Without one, Ridik understands only simple phrases."
          state={key.data}
        />
      )}
    </Group>
  );
}

/* ------------------------------------------------------------- recognition */

function RecognitionGroup() {
  const confidence = useSetting('voiceConfidenceThreshold');
  const silence = useSetting('silenceTimeoutMs');
  const tts = useSetting('ttsEnabled');
  const rate = useSetting('ttsRate');
  const whisper = useSetting('whisperFallbackEnabled');
  const whisperKey = useSecret('whisper');
  const assemblyKey = useSecret('assemblyai');

  return (
    <Group title="Recognition">
      <SliderRow
        label="Confidence threshold"
        hint="Below this, Ridik asks you to say it again instead of guessing."
        value={confidence.value}
        min={0}
        max={1}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={confidence.set}
      />
      <SliderRow
        label="Silence before it stops"
        value={silence.value}
        min={200}
        max={10_000}
        step={100}
        format={(v) => `${(v / 1000).toFixed(1)}s`}
        onChange={(v) => silence.set(Math.round(v))}
      />
      {/*
        Moved off the main screen, and reunited with its own rate control in the
        move — the on/off was a Preference and the speed was here, so a person
        who turned speaking on had no way to reach the dial that makes it
        bearable, and a person who found the dial could not hear it move.

        It is here rather than on Settings because the app is one microphone and
        one answer, and every switch in front of that is a decision taken before
        anything gets done. This one is also off by default, has been for the
        life of the app, and reads every confirmation and the whole briefing out
        loud — a feature nobody asked for, in front of everybody.
      */}
      <SwitchRow
        label="Speak replies"
        hint="Read confirmations and the briefing out loud."
        value={tts.value}
        onChange={tts.set}
      />
      <SliderRow
        label="Speech rate"
        hint="Only audible with Speak replies on."
        value={rate.value}
        min={0.5}
        max={2}
        step={0.05}
        format={(v) => `${v.toFixed(2)}×`}
        onChange={rate.set}
      />
      <SwitchRow
        label="Whisper fallback"
        hint="When the phone cannot hear you, send that one recording to OpenAI instead."
        value={whisper.value}
        onChange={whisper.set}
      />
      {whisper.value ? (
        <SecretRow
          slot="whisper"
          label="Whisper key"
          hint="Needed before any audio is ever uploaded."
          state={whisperKey.data}
        />
      ) : null}
      {/*
        The key is here and the *choice* is on Settings, deliberately.
        
        A key is a developer act — pasting a credential — and choosing to upload
        your voice is not. So this unlocks the engine and changes nothing on its
        own: with a key and the setting untouched, AssemblyAI is only a better
        rescue than Whisper when the recogniser fails outright. Making it the
        engine that runs every time is a decision taken on a screen that says
        what it costs, which is the live caption.
      */}
      {whisper.value ? (
        <SecretRow
          slot="assemblyai"
          label="AssemblyAI key"
          hint="Unlocks the better engine. Choosing it is on Profile → How it listens."
          state={assemblyKey.data}
        />
      ) : null}
    </Group>
  );
}

/* ------------------------------------------------------------------ system */

const LEVEL_TONE: Record<PermissionLevel, 'success' | 'warning' | 'danger' | 'neutral'> = {
  granted: 'success',
  partial: 'warning',
  denied: 'warning',
  blocked: 'danger',
  unavailable: 'neutral',
};

const PERMISSION_LABEL: Record<PermissionId, string> = {
  microphone: 'Microphone & speech',
  calendar: 'Calendar',
  location: 'Location',
  notifications: 'Notifications',
};

function SystemGroup() {
  const permissions = usePermissions();
  const request = useRequestPermission();
  const background = useBackgroundStatus();
  const syncNow = useSyncCalendarNow();
  const timezone = useSetting('timezone');
  const week = useSetting('weekStartsOn');
  const buffer = useSetting('defaultBufferMinutes');
  const toast = useToast();

  const ids = Object.keys(PERMISSION_LABEL) as PermissionId[];

  return (
    <Group title="System">
      {ids.map((id) => {
        const state = permissions.data?.[id];
        const level = state?.level ?? 'unavailable';
        return (
          <Row
            key={id}
            label={PERMISSION_LABEL[id]}
            value={state?.detail}
            right={
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Badge label={level} tone={LEVEL_TONE[level]} />
                {level === 'denied' ? (
                  <Button
                    label="Ask"
                    size="sm"
                    onPress={() =>
                      request.mutate(id, {
                        onError: (error) =>
                          toast.show({ message: error.message, tone: 'danger' }),
                      })
                    }
                  />
                ) : null}
              </View>
            }
          />
        );
      })}
      <Row
        label="Background refresh"
        value={background.data?.availability ?? '…'}
        hint={
          background.data?.briefingAt
            ? `Next briefing ${formatDateTime(background.data.briefingAt)}.`
            : 'No briefing scheduled.'
        }
      />
      <Row
        label="Sync now"
        hint="Drains the outbox immediately instead of waiting for the background pass."
        right={
          <Button
            label="Sync"
            size="sm"
            loading={syncNow.isPending}
            onPress={() =>
              syncNow.mutate(undefined, {
                onSuccess: (summary) =>
                  toast.show({
                    message: summary.queue.skipped
                      ? `Skipped: ${summary.queue.skipped}`
                      : `Pushed ${countLabel(summary.queue.succeeded, 'change')}`,
                  }),
                onError: (error: Error) => toast.show({ message: error.message, tone: 'danger' }),
              })
            }
          />
        }
      />
      <ValidatedTextRow
        label="Time zone"
        hint="Everything you say is resolved against this. A wrong value breaks every date."
        value={timezone.value}
        validate={(next) => (isValidZone(next) ? null : 'Not a time zone Ridik knows.')}
        onCommit={timezone.set}
      />
      <SwitchRow
        label="Week starts on Monday"
        value={week.value === 1}
        onChange={(next) => week.set(next ? 1 : 0)}
      />
      <SliderRow
        label="Default travel buffer"
        hint="Held before anything with a place attached."
        value={buffer.value}
        min={0}
        max={60}
        step={5}
        format={(v) => `${Math.round(v)} min`}
        onChange={(v) => buffer.set(Math.round(v))}
      />
    </Group>
  );
}

/* ----------------------------------------------------------------- storage */

function StorageGroup() {
  const stats = useDatabaseStats();
  const rebuild = useRebuildNoteSearchIndex();
  const toast = useToast();

  const top = useMemo(
    () => stats.data?.tables.filter((t) => t.rows > 0).slice(0, 8) ?? [],
    [stats.data],
  );

  return (
    <Group title="Storage">
      <Row
        icon="server-outline"
        label="On this device"
        value={
          stats.data
            ? `${formatBytes(stats.data.bytes)} · ${countLabel(stats.data.totalRows, 'row')}`
            : '…'
        }
        hint={
          top.length > 0
            ? top.map((t) => `${t.table.replace(/_/g, ' ')} ${t.rows}`).join(' · ')
            : 'Nothing saved yet.'
        }
      />
      <Row
        icon="search-outline"
        label="Rebuild search index"
        hint="Do this if note search starts missing things."
        right={
          <Button
            label="Rebuild"
            size="sm"
            loading={rebuild.isPending}
            onPress={() =>
              rebuild.mutate(undefined, {
                onSuccess: (count) =>
                  toast.show({
                    message: `Reindexed ${countLabel(count, 'note')}`,
                    tone: 'success',
                  }),
                onError: (error: Error) => toast.show({ message: error.message, tone: 'danger' }),
              })
            }
          />
        }
      />
    </Group>
  );
}

/* ------------------------------------------------------------- diagnostics */

const LOG_TONE = {
  debug: 'tertiary',
  info: 'secondary',
  warn: 'warning',
  error: 'danger',
} as const;

function DiagnosticsGroup() {
  const { spacing } = useTheme();
  const entries = useLogEntries(60);
  const toast = useToast();

  const newestFirst = useMemo(() => [...entries].reverse(), [entries]);

  return (
    <Section
      title="Diagnostics"
      right={
        <Button
          label="Copy"
          size="sm"
          variant="ghost"
          onPress={() => {
            void copyToClipboard(
              newestFirst
                .map((e) => `${new Date(e.at).toISOString()} ${e.level} [${e.scope}] ${e.message}`)
                .join('\n'),
            ).then(() => toast.show({ message: 'Log copied' }));
          }}
        />
      }
    >
      <Card style={{ gap: spacing.xs }}>
        {newestFirst.length === 0 ? (
          <Txt variant="caption" tone="tertiary">
            Nothing logged yet.
          </Txt>
        ) : (
          newestFirst.slice(0, 40).map((entry) => (
            <Txt key={entry.seq} variant="mono" tone={LOG_TONE[entry.level]} numberOfLines={2}>
              [{entry.scope}] {entry.message}
            </Txt>
          ))
        )}
      </Card>
    </Section>
  );
}
