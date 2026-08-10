/**
 * Settings — grouped rows at iOS-settings density.
 *
 * Every group is wrapped on its own: a device that refuses to report its
 * calendar permission must not take the API-key field down with it, because
 * that field is the one thing that turns the app from pattern-matching back
 * into a real assistant.
 */
import { Children, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Switch, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { formatDateTime, formatRelative, isValidZone } from '@/core/time';
import { countLabel, truncate } from '@/core/format';
import { copyToClipboard } from '@/features/export';
import { useAssistantUsage, useRebuildNoteSearchIndex, useSetting, useSyncEntries } from '@/hooks';
import { formatCostMicros } from '@/llm/usage';
import {
  useBackgroundStatus,
  useCalendarConnection,
  useConnectCalendar,
  useDatabaseStats,
  useDisconnectCalendar,
  useEraseAllData,
  useExportEverything,
  useLogEntries,
  usePermissions,
  useRequestPermission,
  useSecret,
  useSetSecret,
  useSyncCalendarNow,
  type PermissionId,
  type PermissionLevel,
  type SecretSlot,
} from '@/hooks/useSystem';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import {
  Badge,
  Button,
  Card,
  Chip,
  Divider,
  Input,
  Screen,
  Section,
  Segmented,
  Txt,
  useToast,
} from '@/ui/components';

export default function SettingsScreen() {
  return (
    <Screen title="Settings" subtitle="Voice, sync and what lives on this phone">
      <ErrorBoundary label="settings: account">
        <AccountGroup />
      </ErrorBoundary>
      <ErrorBoundary label="settings: voice">
        <VoiceGroup />
      </ErrorBoundary>
      <ErrorBoundary label="settings: schedule">
        <ScheduleGroup />
      </ErrorBoundary>
      <ErrorBoundary label="settings: permissions">
        <PermissionsGroup />
      </ErrorBoundary>
      <ErrorBoundary label="settings: data">
        <DataGroup />
      </ErrorBoundary>
      <ErrorBoundary label="settings: diagnostics">
        <DiagnosticsGroup />
      </ErrorBoundary>
    </Screen>
  );
}

/* ----------------------------------------------------------------- account */

function AccountGroup() {
  const { colors } = useTheme();
  const toast = useToast();
  const connection = useCalendarConnection();
  const failed = useSyncEntries('failed', 3);
  const connect = useConnectCalendar();
  const disconnect = useDisconnectCalendar();
  const syncNow = useSyncCalendarNow();

  const status = connection.data;
  const connected = status?.connected ?? false;
  const pending = (status?.pending ?? 0) + (status?.inFlight ?? 0);
  const failures = status?.failed ?? 0;
  const lastError = failed.data?.find((entry) => entry.lastError)?.lastError ?? null;

  if (connection.isLoading && !status) return <GroupSkeleton title="Account" rows={2} />;
  if (connection.isError) {
    return (
      <Section title="Account">
        <RetryRow message="Could not read the calendar connection." onRetry={() => connection.refetch()} />
      </Section>
    );
  }

  return (
    <Group title="Account">
      <Row
        icon="logo-google"
        label="Google Calendar"
        value={connected ? (status?.email ?? 'Connected') : 'Not connected'}
        hint={
          !status?.configured
            ? 'Google sign-in is not configured in this build.'
            : connected
              ? status?.lastSyncedAt
                ? `Last synced ${formatRelative(status.lastSyncedAt)}`
                : 'Never synced yet'
              : 'Sign in to push events both ways.'
        }
        right={
          connected ? (
            <Button
              label="Disconnect"
              size="sm"
              variant="ghost"
              loading={disconnect.isPending}
              onPress={() =>
                disconnect.mutate(undefined, {
                  onSuccess: () => toast.show({ message: 'Google disconnected', tone: 'neutral' }),
                  onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
                })
              }
            />
          ) : (
            <Button
              label="Connect"
              size="sm"
              variant="primary"
              disabled={!status?.configured}
              loading={connect.isPending}
              onPress={() =>
                connect.mutate(undefined, {
                  onSuccess: (snapshot) =>
                    toast.show({ message: `Connected as ${snapshot.email ?? 'Google'}`, tone: 'success' }),
                  onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
                })
              }
            />
          )
        }
      />
      <Row
        icon="sync-outline"
        label="Sync now"
        value={
          pending === 0 && failures === 0
            ? 'Everything is up to date'
            : [pending > 0 ? `${pending} queued` : null, failures > 0 ? `${failures} failed` : null]
                .filter(Boolean)
                .join(' · ')
        }
        hint={lastError ? truncate(lastError, 120) : undefined}
        tone={failures > 0 ? 'danger' : undefined}
        right={
          <Button
            label="Sync"
            size="sm"
            loading={syncNow.isPending}
            onPress={() =>
              syncNow.mutate(undefined, {
                onSuccess: (summary) =>
                  toast.show({
                    message: `${summary.queue.succeeded} pushed`,
                    detail: summary.pull
                      ? `${summary.pull.created} new, ${summary.pull.updated} updated`
                      : undefined,
                    tone: 'success',
                  }),
                onError: (error) => toast.show({ message: error.message, tone: 'warning' }),
              })
            }
          />
        }
      />
      <Row
        icon="phone-portrait-outline"
        label="Device calendar"
        value={status?.nativeMirror ? 'Mirroring to the Ridik calendar' : 'Not mirroring'}
        hint={
          status?.nativeMirror
            ? undefined
            : 'Allow calendar access below to see Ridik events in your phone calendar.'
        }
        right={
          <Ionicons
            name={status?.nativeMirror ? 'checkmark-circle' : 'ellipse-outline'}
            size={18}
            color={status?.nativeMirror ? colors.success : colors.textTertiary}
          />
        }
      />
    </Group>
  );
}

/* ------------------------------------------------------------------- voice */

/** The models the Gemini provider actually accepts; anything else is free text. */
const MODEL_PRESETS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.5-pro'];

function VoiceGroup() {
  const { colors, spacing } = useTheme();
  const llmKey = useSecret('llm');
  const whisperKey = useSecret('whisper');
  const model = useSetting('llmModel');
  const tts = useSetting('ttsEnabled');
  const rate = useSetting('ttsRate');
  const confidence = useSetting('voiceConfidenceThreshold');
  const silence = useSetting('silenceTimeoutMs');
  const dailyCap = useSetting('llmDailyRequestCap');
  const monthlyCap = useSetting('llmMonthlyRequestCap');
  const usage = useAssistantUsage(dailyCap.value, monthlyCap.value).data;
  const whisperEnabled = useSetting('whisperFallbackEnabled');

  const [customModel, setCustomModel] = useState(false);
  const offline = llmKey.data ? !llmKey.data.present : false;

  return (
    <Section title="Voice">
      {offline ? (
        <Card accent={colors.warning} style={{ gap: 4 }}>
          <Txt variant="bodyStrong" tone="warning">
            Running in offline mode
          </Txt>
          <Txt variant="caption" tone="secondary">
            With no assistant key, commands fall back to simple pattern matching. "Spent 12 on lunch"
            and short notes still land; anything with dates, dependencies or several intents at once
            will not.
          </Txt>
        </Card>
      ) : null}

      <Card padded={false}>
        <SecretRow
          slot="llm"
          label="Assistant API key"
          hint="Stored in the device keychain, never in the database."
          state={llmKey.data}
        />
        <Divider inset={spacing.md} />
        <View style={{ padding: spacing.md, gap: spacing.sm }}>
          <Txt variant="body">Model</Txt>
          <View style={styles.chips}>
            {MODEL_PRESETS.map((preset) => (
              <Chip
                key={preset}
                label={preset}
                selected={!customModel && model.value === preset}
                onPress={() => {
                  setCustomModel(false);
                  model.set(preset);
                }}
              />
            ))}
            <Chip
              label="Other…"
              selected={customModel || !MODEL_PRESETS.includes(model.value)}
              onPress={() => setCustomModel(true)}
            />
          </View>
          {customModel || !MODEL_PRESETS.includes(model.value) ? (
            <DraftInput
              value={model.value}
              onCommit={model.set}
              placeholder="gemini-…"
              accessibilityLabel="Model name"
            />
          ) : null}
          <Txt variant="micro" tone="tertiary">
            Only Gemini names are sent to the provider; anything else falls back to the built-in
            default.
          </Txt>
        </View>
        <Divider inset={spacing.md} />
        <SwitchRow
          label="Speak replies"
          hint="Read confirmations and the briefing out loud."
          value={tts.value}
          onChange={tts.set}
        />
        <Divider inset={spacing.md} />
        <SliderRow
          label="Speech rate"
          value={rate.value}
          min={0.5}
          max={2}
          step={0.05}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={rate.set}
        />
        <Divider inset={spacing.md} />
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
        <Divider inset={spacing.md} />
        <SliderRow
          label="Silence before it stops"
          value={silence.value}
          min={200}
          max={10_000}
          step={100}
          format={(v) => `${(v / 1000).toFixed(1)}s`}
          onChange={(v) => silence.set(Math.round(v))}
        />
        <Divider inset={spacing.md} />
        <SliderRow
          label="Requests per day"
          hint={
            dailyCap.value === 0
              ? 'Unlimited. Set a number to cap what the assistant can spend in a day.'
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
        <Divider inset={spacing.md} />
        <SliderRow
          label="Requests per month"
          hint={
            monthlyCap.value === 0
              ? 'Unlimited.'
              : `${usage?.remainingThisMonth ?? monthlyCap.value} left this month${
                  usage ? ` · ${formatCostMicros(usage.month.costMicros)} so far` : ''
                }. Past the cap, commands fall back to pattern matching rather than stopping.`
          }
          value={monthlyCap.value}
          min={0}
          max={20_000}
          step={250}
          format={(v) => (v === 0 ? 'Off' : String(Math.round(v)))}
          onChange={(v) => monthlyCap.set(Math.round(v))}
        />
        <Divider inset={spacing.md} />
        <SwitchRow
          label="Whisper fallback"
          hint="When the phone cannot hear you, send that one recording to OpenAI instead."
          value={whisperEnabled.value}
          onChange={whisperEnabled.set}
        />
        {whisperEnabled.value ? (
          <>
            <Divider inset={spacing.md} />
            <SecretRow
              slot="whisper"
              label="Whisper API key"
              hint="Needed before any audio is ever uploaded."
              state={whisperKey.data}
            />
          </>
        ) : null}
      </Card>
    </Section>
  );
}

function SecretRow({
  slot,
  label,
  hint,
  state,
}: {
  slot: SecretSlot;
  label: string;
  hint: string;
  state: { present: boolean; preview: string | null } | undefined;
}) {
  const { spacing } = useTheme();
  const toast = useToast();
  const save = useSetSecret();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = (value: string | null) => {
    save.mutate(
      { slot, value },
      {
        onSuccess: () => {
          setEditing(false);
          setDraft('');
          toast.show({ message: value ? 'Key saved' : 'Key removed', tone: value ? 'success' : 'neutral' });
        },
        onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
      },
    );
  };

  if (editing) {
    return (
      <View style={{ padding: spacing.md, gap: spacing.sm }}>
        <Input
          label={label}
          value={draft}
          onChangeText={setDraft}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Paste the key"
          autoFocus
        />
        <View style={styles.chips}>
          <Button
            label="Save"
            size="sm"
            variant="primary"
            disabled={draft.trim().length === 0}
            loading={save.isPending}
            onPress={() => commit(draft)}
          />
          <Button
            label="Cancel"
            size="sm"
            variant="ghost"
            onPress={() => {
              setEditing(false);
              setDraft('');
            }}
          />
          {state?.present ? (
            <Button label="Remove" size="sm" variant="danger" onPress={() => commit(null)} />
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <Row
      icon="key-outline"
      label={label}
      value={state?.preview ?? 'Not set'}
      hint={hint}
      right={<Button label={state?.present ? 'Change' : 'Add'} size="sm" onPress={() => setEditing(true)} />}
    />
  );
}

/* ---------------------------------------------------------------- schedule */

function ScheduleGroup() {
  const buffer = useSetting('defaultBufferMinutes');
  const briefingEnabled = useSetting('briefingEnabled');
  const briefingHour = useSetting('briefingHour');
  const weekStart = useSetting('weekStartsOn');
  const timezone = useSetting('timezone');
  const currency = useSetting('primaryCurrency');
  const { spacing } = useTheme();

  return (
    <Section title="Schedule">
      <Card padded={false}>
        <SliderRow
          label="Default travel buffer"
          hint="Held before anything with a place attached."
          value={buffer.value}
          min={0}
          max={120}
          step={5}
          format={(v) => (v === 0 ? 'None' : `${Math.round(v)} min`)}
          onChange={(v) => buffer.set(Math.round(v))}
        />
        <Divider inset={spacing.md} />
        <SwitchRow
          label="Morning briefing"
          hint="One notification with the day ahead."
          value={briefingEnabled.value}
          onChange={briefingEnabled.set}
        />
        {briefingEnabled.value ? (
          <>
            <Divider inset={spacing.md} />
            <SliderRow
              label="Briefing at"
              value={briefingHour.value}
              min={0}
              max={23}
              step={1}
              format={(v) => `${String(Math.round(v)).padStart(2, '0')}:00`}
              onChange={(v) => briefingHour.set(Math.round(v))}
            />
          </>
        ) : null}
        <Divider inset={spacing.md} />
        <View style={{ padding: spacing.md, gap: spacing.sm }}>
          <Txt variant="body">Week starts on</Txt>
          <Segmented
            value={weekStart.value === 0 ? 'sun' : 'mon'}
            onChange={(v) => weekStart.set(v === 'sun' ? 0 : 1)}
            options={[
              { value: 'mon', label: 'Monday' },
              { value: 'sun', label: 'Sunday' },
            ]}
          />
        </View>
        <Divider inset={spacing.md} />
        <ValidatedTextRow
          label="Time zone"
          value={timezone.value}
          placeholder="Europe/Sofia"
          validate={(next) => (isValidZone(next) ? null : 'Not an IANA time zone name.')}
          onCommit={timezone.set}
          hint="Everything you say is resolved against this zone."
        />
        <Divider inset={spacing.md} />
        <ValidatedTextRow
          label="Primary currency"
          value={currency.value}
          placeholder="EUR"
          transform={(text) => text.toUpperCase().slice(0, 3)}
          validate={(next) => (/^[A-Z]{3}$/.test(next) ? null : 'Three letters, like EUR or USD.')}
          onCommit={currency.set}
        />
      </Card>
    </Section>
  );
}

/* ------------------------------------------------------------- permissions */

const PERMISSION_LABELS: Record<PermissionId, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  microphone: { label: 'Microphone & speech', icon: 'mic-outline' },
  calendar: { label: 'Calendar', icon: 'calendar-outline' },
  location: { label: 'Location (always)', icon: 'location-outline' },
  notifications: { label: 'Notifications', icon: 'notifications-outline' },
};

const LEVEL_TONE: Record<PermissionLevel, 'success' | 'warning' | 'danger' | 'neutral'> = {
  granted: 'success',
  partial: 'warning',
  denied: 'warning',
  blocked: 'danger',
  unavailable: 'neutral',
};

const LEVEL_LABEL: Record<PermissionLevel, string> = {
  granted: 'GRANTED',
  partial: 'PARTIAL',
  denied: 'NOT ASKED',
  blocked: 'BLOCKED',
  unavailable: 'N/A',
};

function PermissionsGroup() {
  const permissions = usePermissions();
  const request = useRequestPermission();
  const background = useBackgroundStatus();
  const { spacing } = useTheme();

  if (permissions.isLoading && !permissions.data) return <GroupSkeleton title="Permissions" rows={4} />;
  if (permissions.isError) {
    return (
      <Section title="Permissions">
        <RetryRow message="Could not read device permissions." onRetry={() => permissions.refetch()} />
      </Section>
    );
  }

  const rows = permissions.data
    ? (Object.keys(PERMISSION_LABELS) as PermissionId[]).map((id) => permissions.data[id])
    : [];

  return (
    <Section title="Permissions">
      <Card padded={false}>
        {rows.map((row, index) => (
          <View key={row.id}>
            {index > 0 ? <Divider inset={spacing.md} /> : null}
            <Row
              icon={PERMISSION_LABELS[row.id].icon}
              label={PERMISSION_LABELS[row.id].label}
              hint={row.detail}
              right={
                <View style={styles.rowActions}>
                  <Badge label={LEVEL_LABEL[row.level]} tone={LEVEL_TONE[row.level]} />
                  {row.level === 'blocked' ? (
                    <Button
                      label="Settings"
                      size="sm"
                      variant="ghost"
                      onPress={() => void Linking.openSettings().catch(() => {})}
                    />
                  ) : row.level === 'granted' || row.level === 'unavailable' ? null : (
                    <Button
                      label="Grant"
                      size="sm"
                      variant="primary"
                      loading={request.isPending && request.variables === row.id}
                      onPress={() => request.mutate(row.id)}
                    />
                  )}
                </View>
              }
            />
          </View>
        ))}
        <Divider inset={spacing.md} />
        <Row
          icon="refresh-outline"
          label="Background refresh"
          value={
            background.data
              ? background.data.availability === 'available'
                ? background.data.taskRegistered
                  ? `Every ${background.data.intervalMinutes} min or so`
                  : 'Allowed, but not registered'
                : background.data.availability === 'restricted'
                  ? 'Switched off for Ridik'
                  : 'Unknown'
              : '…'
          }
          hint={
            background.data?.briefingAt
              ? `Next briefing ${formatDateTime(background.data.briefingAt)}`
              : 'The OS decides when this runs; nothing here is guaranteed.'
          }
          right={
            background.data?.availability === 'restricted' ? (
              <Button
                label="Settings"
                size="sm"
                variant="ghost"
                onPress={() => void Linking.openSettings().catch(() => {})}
              />
            ) : undefined
          }
        />
      </Card>
    </Section>
  );
}

/* -------------------------------------------------------------------- data */

function DataGroup() {
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const stats = useDatabaseStats();
  const rebuild = useRebuildNoteSearchIndex();
  const exportAll = useExportEverything();
  const erase = useEraseAllData();
  const [confirm, setConfirm] = useState('');
  const [armed, setArmed] = useState(false);

  const top = useMemo(() => stats.data?.tables.filter((t) => t.rows > 0).slice(0, 6) ?? [], [stats.data]);

  return (
    <Section title="Data">
      <Card padded={false}>
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
        <Divider inset={spacing.md} />
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
                    toast.show({ message: `Reindexed ${countLabel(count, 'note')}`, tone: 'success' }),
                  onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
                })
              }
            />
          }
        />
        <Divider inset={spacing.md} />
        <Row
          icon="download-outline"
          label="Export everything"
          hint="One markdown file with every note, task, list and transaction."
          right={
            <Button
              label="Export"
              size="sm"
              loading={exportAll.isPending}
              onPress={() =>
                exportAll.mutate(undefined, {
                  onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
                })
              }
            />
          }
        />
      </Card>

      <Card accent={colors.danger} style={{ gap: spacing.sm }}>
        <Txt variant="bodyStrong" tone="danger">
          Erase all data
        </Txt>
        <Txt variant="caption" tone="secondary">
          Every note, task, list, place and transaction on this phone. There is no backup and no undo.
        </Txt>
        {armed ? (
          <>
            <Input
              label="Type ERASE to confirm"
              value={confirm}
              onChangeText={setConfirm}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="ERASE"
            />
            <View style={styles.chips}>
              <Button
                label="Erase everything"
                size="sm"
                variant="danger"
                disabled={confirm.trim() !== 'ERASE'}
                loading={erase.isPending}
                onPress={() =>
                  erase.mutate(undefined, {
                    onSuccess: () => {
                      setArmed(false);
                      setConfirm('');
                      toast.show({ message: 'Everything erased', tone: 'neutral' });
                    },
                    onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
                  })
                }
              />
              <Button
                label="Cancel"
                size="sm"
                variant="ghost"
                onPress={() => {
                  setArmed(false);
                  setConfirm('');
                }}
              />
            </View>
          </>
        ) : (
          <Button label="Erase all data" size="sm" variant="danger" onPress={() => setArmed(true)} />
        )}
      </Card>
    </Section>
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
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const entries = useLogEntries(60);
  const recent = useMemo(() => [...entries].reverse(), [entries]);

  return (
    <Section
      title="Diagnostics"
      right={
        <Button
          label="Copy"
          icon="copy-outline"
          size="sm"
          variant="ghost"
          onPress={() => {
            void copyToClipboard(
              recent
                .map((e) => `${formatDateTime(e.at)} ${e.level.toUpperCase()} [${e.scope}] ${e.message}`)
                .join('\n'),
            ).then((result) =>
              toast.show({
                message: result.ok ? 'Log copied' : 'Could not copy the log',
                tone: result.ok ? 'success' : 'danger',
              }),
            );
          }}
        />
      }
    >
      <Card padded={false} style={{ paddingVertical: spacing.xs }}>
        {recent.length === 0 ? (
          <Txt variant="caption" tone="tertiary" style={{ padding: spacing.md }}>
            Nothing logged this session.
          </Txt>
        ) : (
          recent.map((entry, index) => (
            <View
              key={entry.seq}
              style={{ paddingHorizontal: spacing.md, paddingVertical: 4, gap: 1 }}
            >
              <Txt variant="micro" tone="tertiary">
                {formatDateTime(entry.at)} · {entry.scope}
              </Txt>
              <Txt variant="mono" tone={LOG_TONE[entry.level]} numberOfLines={3}>
                {entry.message}
              </Txt>
              {index < recent.length - 1 ? (
                <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginTop: 4 }} />
              ) : null}
            </View>
          ))
        )}
      </Card>
    </Section>
  );
}

/* ------------------------------------------------------------- row shapes */

function Group({ title, children }: { title: string; children: ReactNode }) {
  const { spacing } = useTheme();
  const rows = Children.toArray(children);
  return (
    <Section title={title}>
      <Card padded={false}>
        {rows.map((row, index) => (
          <View key={index}>
            {index > 0 ? <Divider inset={spacing.md} /> : null}
            {row}
          </View>
        ))}
      </Card>
    </Section>
  );
}

function Row({
  icon,
  label,
  value,
  hint,
  right,
  tone,
  onPress,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  label: string;
  value?: string;
  hint?: string;
  right?: ReactNode;
  tone?: 'danger' | 'warning';
  onPress?: () => void;
}) {
  const { colors, spacing } = useTheme();
  const body = (
    <View style={[styles.row, { paddingHorizontal: spacing.md, gap: spacing.md }]}>
      {icon ? <Ionicons name={icon} size={19} color={tone ? colors[tone] : colors.textSecondary} /> : null}
      <View style={{ flex: 1, gap: 1 }}>
        <Txt variant="body">{label}</Txt>
        {value ? (
          <Txt variant="caption" tone={tone ?? 'secondary'}>
            {value}
          </Txt>
        ) : null}
        {hint ? (
          <Txt variant="micro" tone="tertiary">
            {hint}
          </Txt>
        ) : null}
      </View>
      {right}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {body}
    </Pressable>
  );
}

function SwitchRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const { colors } = useTheme();
  return (
    <Row
      label={label}
      hint={hint}
      right={
        <Switch
          value={value}
          onValueChange={onChange}
          accessibilityLabel={label}
          accessibilityState={{ checked: value }}
          trackColor={{ false: colors.borderStrong, true: colors.accent }}
          thumbColor="#FFFFFF"
        />
      }
    />
  );
}

/**
 * A slider with no slider dependency: a track that reads its own width and maps
 * a touch to a value.
 *
 * The drag is local and only the release is written. A finger crossing this
 * track emits a move event per frame, and persisting each one would put sixty
 * upserts through SQLite to change one number. Registered as `adjustable` so
 * VoiceOver can step it, which a bare pan responder would not be.
 */
function SliderRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (next: number) => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const [width, setWidth] = useState(0);
  const [shown, setShown] = useState(value);
  const [dragging, setDragging] = useState(false);

  // The stored value wins whenever the finger is off the track — including the
  // moment a rollback puts the old number back.
  useEffect(() => {
    if (!dragging) setShown(value);
  }, [value, dragging]);

  const clamp = (next: number) => {
    const snapped = Math.round(next / step) * step;
    return Math.min(max, Math.max(min, Number(snapped.toFixed(4))));
  };
  const fraction = max === min ? 0 : (shown - min) / (max - min);

  const handleTouch = (x: number) => {
    if (width <= 0) return;
    setDragging(true);
    setShown(clamp(min + (Math.min(Math.max(x, 0), width) / width) * (max - min)));
  };
  const release = () => {
    setDragging(false);
    if (shown !== value) onChange(shown);
  };

  return (
    <View style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2, gap: 6 }}>
      <View style={styles.sliderHead}>
        <Txt variant="body">{label}</Txt>
        <Txt variant="mono" tone="accent">
          {format(shown)}
        </Txt>
      </View>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min, max, now: shown, text: format(shown) }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(event) =>
          onChange(clamp(value + (event.nativeEvent.actionName === 'increment' ? step : -step)))
        }
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(event) => handleTouch(event.nativeEvent.locationX)}
        onResponderMove={(event) => handleTouch(event.nativeEvent.locationX)}
        onResponderRelease={release}
        onResponderTerminate={release}
        // 32pt of touchable height around a 4pt rule: this is dragged with a thumb.
        style={styles.sliderTrackArea}
      >
        <View style={{ height: 4, borderRadius: radius.pill, backgroundColor: colors.surfaceSunken }}>
          <View
            style={{
              height: 4,
              borderRadius: radius.pill,
              backgroundColor: colors.accent,
              width: `${Math.round(fraction * 100)}%`,
            }}
          />
        </View>
        <View
          pointerEvents="none"
          style={[
            styles.sliderThumb,
            {
              backgroundColor: colors.accent,
              borderColor: colors.bg,
              left: Math.max(0, Math.min(Math.max(0, width - 16), fraction * width - 8)),
            },
          ]}
        />
      </View>
      {hint ? (
        <Txt variant="micro" tone="tertiary">
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

/** A free-text setting written on blur rather than on every keystroke. */
function DraftInput({
  value,
  onCommit,
  placeholder,
  accessibilityLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  accessibilityLabel?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      value={draft ?? value}
      onChangeText={setDraft}
      onBlur={() => {
        const next = draft?.trim();
        if (next && next !== value) onCommit(next);
        setDraft(null);
      }}
      autoCapitalize="none"
      autoCorrect={false}
      placeholder={placeholder}
      accessibilityLabel={accessibilityLabel}
    />
  );
}

/**
 * A text setting that is only written once it is valid — a half-typed zone name
 * would otherwise be saved on every keystroke and break every date on screen.
 */
function ValidatedTextRow({
  label,
  value,
  hint,
  placeholder,
  transform,
  validate,
  onCommit,
}: {
  label: string;
  value: string;
  hint?: string;
  placeholder?: string;
  transform?: (text: string) => string;
  validate: (value: string) => string | null;
  onCommit: (value: string) => void;
}) {
  const { spacing } = useTheme();
  const [draft, setDraft] = useState<string | null>(null);
  const current = draft ?? value;
  const error = draft === null ? null : validate(draft.trim());

  return (
    <View style={{ padding: spacing.md, gap: spacing.sm }}>
      <Input
        label={label}
        value={current}
        onChangeText={(text) => setDraft(transform ? transform(text) : text)}
        onBlur={() => {
          if (draft !== null && validate(draft.trim()) === null) onCommit(draft.trim());
          setDraft(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={placeholder}
        error={error ?? undefined}
      />
      {draft !== null && !error && draft.trim() !== value ? (
        <Button
          label="Save"
          size="sm"
          variant="primary"
          onPress={() => {
            onCommit(draft.trim());
            setDraft(null);
          }}
        />
      ) : hint ? (
        <Txt variant="micro" tone="tertiary">
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

function GroupSkeleton({ title, rows }: { title: string; rows: number }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <Section title={title}>
      <Card padded={false}>
        {Array.from({ length: rows }, (_, index) => (
          <View key={index} style={{ padding: spacing.md, gap: 6 }}>
            <View
              style={{ height: 12, width: '45%', borderRadius: radius.sm, backgroundColor: colors.surfaceSunken }}
            />
            <View
              style={{ height: 10, width: '70%', borderRadius: radius.sm, backgroundColor: colors.surfaceSunken }}
            />
          </View>
        ))}
      </Card>
    </Section>
  );
}

function RetryRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Txt variant="caption" tone="danger">
            {message}
          </Txt>
        </View>
        <Button label="Retry" size="sm" variant="ghost" onPress={onRetry} />
      </View>
    </Card>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingVertical: 10, gap: 12 },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  sliderHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sliderTrackArea: { justifyContent: 'center', height: 32 },
  sliderThumb: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
  },
});
