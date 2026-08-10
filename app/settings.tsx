/**
 * Settings, deliberately small.
 *
 * Every knob here is one a person can reasonably want to change and cannot
 * break the app by getting wrong. Everything else — the model name, the
 * confidence threshold, the silence window, the spend caps, the diagnostics log
 * — is engineering instrumentation. It still exists and still works; it lives
 * on `/developer`, behind seven taps on the version row.
 *
 * The test for belonging on this screen: if a stranger set it to the worst
 * possible value, would the app still work? A timezone text field fails that —
 * one typo and every date in the app is wrong. A model name fails it — one typo
 * and voice is dead. "Speak replies" passes.
 *
 * Permissions are not listed either. An inventory of four rows with green ticks
 * is a developer's view of the system; what a person needs is to be told, once,
 * when something they switched on cannot work yet.
 */
import { useCallback, useState } from 'react';
import { Linking, View } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';

import { createLogger } from '@/core/logger';
import { formatRelative } from '@/core/time';
import {
  Group,
  GroupSkeleton,
  RetryRow,
  Row,
  SecretRow,
  SliderRow,
  SwitchRow,
} from '@/features/settings';
import { useSetting } from '@/hooks';
import { useAssistantMode } from '@/hooks/useAssistant';
import {
  useCalendarConnection,
  useConnectCalendar,
  useDisconnectCalendar,
  useEraseAllData,
  useExportEverything,
  usePermissions,
  useRequestPermission,
  useSecret,
  type PermissionId,
} from '@/hooks/useSystem';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import { Button, Input, Screen, Txt, useToast } from '@/ui/components';

const log = createLogger('settings');

export default function SettingsScreen() {
  const developer = useSetting('developerMode');

  return (
    <Screen title="Settings">
      <ErrorBoundary label="settings: attention">
        <AttentionGroup />
      </ErrorBoundary>
      <ErrorBoundary label="settings: voice">
        <VoiceGroup />
      </ErrorBoundary>
      <ErrorBoundary label="settings: calendar">
        <CalendarGroup />
      </ErrorBoundary>
      <ErrorBoundary label="settings: setup">
        <SetupGroup />
      </ErrorBoundary>
      <ErrorBoundary label="settings: data">
        <DataGroup />
      </ErrorBoundary>
      <ErrorBoundary label="settings: about">
        <AboutGroup unlocked={developer.value} onUnlock={() => developer.set(true)} />
      </ErrorBoundary>
    </Screen>
  );
}

/* --------------------------------------------------------------- attention */

const PERMISSION_COPY: Record<PermissionId, { label: string; why: string }> = {
  microphone: { label: 'Microphone', why: 'Ridik cannot hear you without it.' },
  notifications: { label: 'Notifications', why: 'Reminders and the briefing will not arrive.' },
  calendar: { label: 'Calendar', why: 'Events cannot appear in your phone calendar.' },
  location: { label: 'Location', why: 'Place reminders will not fire.' },
};

/**
 * The only permission surface: what is both needed and missing.
 *
 * Microphone is always needed — it is the product. Notifications only once the
 * briefing is on, which is also the moment the request makes sense to the
 * person answering it.
 */
function AttentionGroup() {
  const permissions = usePermissions();
  const request = useRequestPermission();
  const briefing = useSetting('briefingEnabled');
  const toast = useToast();

  const state = permissions.data;
  if (!state) return null;

  const needed: PermissionId[] = ['microphone'];
  if (briefing.value) needed.push('notifications');

  const missing = needed.filter((id) => {
    const level = state[id]?.level;
    return level === 'denied' || level === 'blocked';
  });
  if (missing.length === 0) return null;

  return (
    <Group title="Needs your permission">
      {missing.map((id) => {
        const blocked = state[id]?.level === 'blocked';
        return (
          <Row
            key={id}
            icon="alert-circle-outline"
            tone="warning"
            label={PERMISSION_COPY[id].label}
            value={PERMISSION_COPY[id].why}
            right={
              <Button
                label={blocked ? 'Open settings' : 'Allow'}
                size="sm"
                variant="primary"
                onPress={() => {
                  if (blocked) {
                    // Once it is blocked the OS will not ask again; the only
                    // route left is the system settings app.
                    void Linking.openSettings().catch(() =>
                      toast.show({ message: 'Could not open settings.', tone: 'danger' }),
                    );
                    return;
                  }
                  request.mutate(id, {
                    onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
                  });
                }}
              />
            }
          />
        );
      })}
    </Group>
  );
}

/* ------------------------------------------------------------------- voice */

function VoiceGroup() {
  const tts = useSetting('ttsEnabled');
  const briefing = useSetting('briefingEnabled');
  const hour = useSetting('briefingHour');
  const mode = useAssistantMode();
  const key = useSecret('llm');

  // A key row only makes sense in a build that talks to a provider directly. A
  // store build routes through the backend and has nothing to paste.
  const showKey = mode.data === 'personal-key' || mode.data === 'offline';

  return (
    <Group title="Voice">
      <SwitchRow
        label="Speak replies"
        hint="Read confirmations and the briefing out loud."
        value={tts.value}
        onChange={tts.set}
      />
      <SwitchRow
        label="Morning briefing"
        hint="One notification with the day ahead."
        value={briefing.value}
        onChange={briefing.set}
      />
      {briefing.value ? (
        <SliderRow
          label="Briefing at"
          value={hour.value}
          min={4}
          max={12}
          step={1}
          format={(v) => `${String(Math.round(v)).padStart(2, '0')}:00`}
          onChange={(v) => hour.set(Math.round(v))}
        />
      ) : null}
      {showKey ? (
        <SecretRow
          slot="llm"
          label="Assistant key"
          hint="Kept in the device keychain. Without one, Ridik understands only simple phrases."
          state={key.data}
        />
      ) : null}
    </Group>
  );
}

/* ---------------------------------------------------------------- calendar */

function CalendarGroup() {
  const connection = useCalendarConnection();
  const connect = useConnectCalendar();
  const disconnect = useDisconnectCalendar();
  const toast = useToast();

  if (connection.isLoading && !connection.data) return <GroupSkeleton title="Calendar" rows={1} />;
  if (connection.isError) {
    return (
      <Group title="Calendar">
        <RetryRow
          message="Could not read your calendar status."
          onRetry={() => void connection.refetch()}
        />
      </Group>
    );
  }

  const status = connection.data;
  const connected = status?.connected ?? false;
  const configured = status?.configured ?? false;

  return (
    <Group title="Calendar">
      <Row
        icon="calendar-outline"
        label="Google Calendar"
        value={
          !configured
            ? 'Not available in this build'
            : connected
              ? (status?.email ?? 'Connected')
              : 'Not connected'
        }
        hint={
          connected
            ? 'Your events sync both ways in the background.'
            : 'Events stay on this phone until you connect it.'
        }
        right={
          !configured ? undefined : connected ? (
            <Button
              label="Disconnect"
              size="sm"
              loading={disconnect.isPending}
              onPress={() =>
                disconnect.mutate(undefined, {
                  onSuccess: () => toast.show({ message: 'Disconnected' }),
                  onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
                })
              }
            />
          ) : (
            <Button
              label="Connect"
              size="sm"
              variant="primary"
              loading={connect.isPending}
              onPress={() =>
                connect.mutate(undefined, {
                  onSuccess: () => toast.show({ message: 'Connected', tone: 'success' }),
                  onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
                })
              }
            />
          )
        }
      />
    </Group>
  );
}

/* ------------------------------------------------------------------- setup */

/**
 * Two screens' worth of data people set up once. Not settings, so they are
 * links rather than controls — but this is where someone goes looking for them,
 * which matters more than the taxonomy.
 */
function SetupGroup() {
  const router = useRouter();
  return (
    <Group title="Setup">
      <Row
        icon="school-outline"
        label="Your week"
        hint="Classes and anything that repeats. Ridik uses it to work out when homework is due."
        right={<Chevron />}
        onPress={() => router.push('/curriculum')}
      />
      <Row
        icon="location-outline"
        label="Places"
        hint="Home, the lab — so you can be reminded when you arrive."
        right={<Chevron />}
        onPress={() => router.push('/places')}
      />
    </Group>
  );
}

/* -------------------------------------------------------------------- data */

function DataGroup() {
  const exportAll = useExportEverything();
  const erase = useEraseAllData();
  const toast = useToast();
  const { spacing } = useTheme();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');

  const doErase = useCallback(() => {
    erase.mutate(undefined, {
      onSuccess: () => {
        setConfirming(false);
        setTyped('');
        toast.show({ message: 'Everything erased', tone: 'neutral' });
      },
      onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
    });
  }, [erase, toast]);

  return (
    <Group title="Your data">
      <Row
        icon="download-outline"
        label="Export everything"
        hint="One markdown file with your notes, tasks, lists and log."
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
      {confirming ? (
        <View style={{ padding: spacing.md, gap: spacing.sm }}>
          <Txt variant="body" tone="danger">
            This deletes everything on this phone. There is no backup and no undo.
          </Txt>
          <Input
            label="Type ERASE to confirm"
            value={typed}
            onChangeText={setTyped}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="ERASE"
          />
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Button
              label="Erase everything"
              size="sm"
              variant="danger"
              disabled={typed.trim().toUpperCase() !== 'ERASE'}
              loading={erase.isPending}
              onPress={doErase}
            />
            <Button
              label="Cancel"
              size="sm"
              variant="ghost"
              onPress={() => {
                setConfirming(false);
                setTyped('');
              }}
            />
          </View>
        </View>
      ) : (
        <Row
          icon="trash-outline"
          tone="danger"
          label="Delete all data"
          hint="Everything Ridik keeps on this phone."
          right={
            <Button label="Delete" size="sm" variant="danger" onPress={() => setConfirming(true)} />
          }
        />
      )}
    </Group>
  );
}

/* ------------------------------------------------------------------- about */

/** Taps on the version row that reveal the engineering surface. */
const UNLOCK_TAPS = 7;

function AboutGroup({ unlocked, onUnlock }: { unlocked: boolean; onUnlock: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [taps, setTaps] = useState(0);

  const extra = (Constants.expoConfig?.extra ?? {}) as {
    legal?: { privacy?: string; terms?: string };
  };
  const version = Constants.expoConfig?.version ?? '1.0.0';

  const open = (url: string | undefined, what: string) => {
    if (!url) {
      toast.show({ message: `No ${what} link is set up yet.`, tone: 'warning' });
      return;
    }
    void Linking.openURL(url).catch((error: unknown) => {
      log.warn(`could not open the ${what}`, error);
      toast.show({ message: `Could not open the ${what}.`, tone: 'danger' });
    });
  };

  return (
    <Group title="About">
      <Row
        label="Version"
        value={version}
        onPress={() => {
          if (unlocked) {
            router.push('/developer');
            return;
          }
          const next = taps + 1;
          setTaps(next);
          if (next >= UNLOCK_TAPS) {
            onUnlock();
            setTaps(0);
            toast.show({ message: 'Developer options unlocked' });
          }
        }}
      />
      <Row
        icon="lock-closed-outline"
        label="Privacy policy"
        right={<Chevron />}
        onPress={() => open(extra.legal?.privacy, 'privacy policy')}
      />
      <Row
        icon="document-text-outline"
        label="Terms of use"
        right={<Chevron />}
        onPress={() => open(extra.legal?.terms, 'terms')}
      />
      {unlocked ? (
        <Row
          icon="construct-outline"
          label="Developer"
          hint="Model, limits and diagnostics."
          right={<Chevron />}
          onPress={() => router.push('/developer')}
        />
      ) : null}
    </Group>
  );
}

function Chevron() {
  const { colors } = useTheme();
  return (
    <Txt variant="body" style={{ color: colors.textTertiary }}>
      ›
    </Txt>
  );
}
