/**
 * Profile: who you are to Ridik, what you are paying for, and your data.
 *
 * There is one preference left on it. Every knob here has to be one a person can
 * reasonably want to change and cannot break the app by getting wrong — and by
 * that test almost nothing qualified. The model name fails it: one typo and
 * voice is dead. The briefing hour failed a different test: it was a decision
 * the app should make, not a slider. "Speak replies" passes.
 *
 * Engineering instrumentation — the model, the confidence threshold, the spend
 * caps, the assistant key, connecting Google Calendar — still exists and still
 * works. It lives on `/developer`, behind seven taps on the version row, where
 * a paying user will never meet it.
 *
 * Permissions are not inventoried either. Four rows with green ticks is a
 * developer's view of the system; what a person needs is to be told, once, when
 * something they switched on cannot work yet.
 */
import { useCallback, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';

import { createLogger } from '@/core/logger';
import { now } from '@/core/clock';
import { formatDayHeading } from '@/core/time';
import {
  Group,
  GroupSkeleton,
  RetryRow,
  Row,
  SecretRow,
  SliderRow,
  SwitchRow,
} from '@/features/settings';
import { useEmber, useSetting } from '@/hooks';
import { useEntitlement } from '@/hooks/useBilling';
import { ASSISTANT_PROVIDER, type AssistantConsent } from '@/llm/consent';
import { describePlan, describeRenewal, FREE } from '@/services/billing/entitlement';
import {
  useEraseAllData,
  useExportEverything,
  usePermissions,
  useRequestPermission,
  type PermissionId,
} from '@/hooks/useSystem';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import type { EmberOption } from '@/ui/theme';
import { useNavigateOnce } from '@/ui/useNavigateOnce';
import { Button, Input, Screen, Txt, useToast } from '@/ui/components';

const log = createLogger('settings');

export default function SettingsScreen() {
  const developer = useSetting('developerMode');

  return (
    <Screen back title="Profile">
      <ErrorBoundary label="profile: plan">
        <PlanGroup />
      </ErrorBoundary>
      <ErrorBoundary label="profile: attention">
        <AttentionGroup />
      </ErrorBoundary>
      <ErrorBoundary label="profile: assistant">
        <AssistantGroup />
      </ErrorBoundary>
      <ErrorBoundary label="profile: preferences">
        <PreferencesGroup />
      </ErrorBoundary>
      <ErrorBoundary label="profile: colour">
        <ColourGroup />
      </ErrorBoundary>
      <ErrorBoundary label="profile: data">
        <DataGroup />
      </ErrorBoundary>
      <ErrorBoundary label="profile: about">
        <AboutGroup unlocked={developer.value} onUnlock={() => developer.set(true)} />
      </ErrorBoundary>
    </Screen>
  );
}

/* -------------------------------------------------------------------- plan */

/**
 * What you are paying for, and how to stop.
 *
 * Reads the entitlement seam rather than a store SDK, so it is the same screen
 * whether or not `react-native-purchases` is compiled into the build. In a
 * build without it there is nothing to show and the group renders nothing at
 * all — a "Free" badge in a build that cannot sell anything is just noise.
 *
 * Managing and cancelling deliberately hand off to the platform. Both stores
 * require it, and an in-app cancel flow would be a lie: only the store can
 * actually end the subscription.
 */
/**
 * What you are paying for, and the way in to changing it.
 *
 * Always shown, even on the free tier and even in a build with no store
 * compiled in. The previous version hid itself when billing was unconfigured,
 * which meant the one screen a paying customer would look for did not exist on
 * any simulator and could never be reviewed. A plan the user does not have is
 * still a fact about their account.
 */
function PlanGroup() {
  const nav = useNavigateOnce();
  const entitlement = useEntitlement();

  if (entitlement.isLoading && !entitlement.data) return <GroupSkeleton title="Plan" rows={1} />;

  const plan = entitlement.data ?? FREE;
  const renewal = describeRenewal(plan, (at) => formatDayHeading(at, undefined, now()));

  return (
    <Group title="Plan">
      <Row
        icon={plan.active ? 'checkmark-circle-outline' : 'sparkles-outline'}
        label={plan.active ? `${describePlan(plan)} · the assistant` : 'Free'}
        hint={renewal}
        right={
          <Button
            label={plan.active ? 'Manage' : 'See plans'}
            size="sm"
            variant={plan.active ? 'secondary' : 'primary'}
            onPress={() => nav.push('/plans')}
          />
        }
      />
    </Group>
  );
}

/* --------------------------------------------------------------- attention */

const PERMISSION_COPY: Record<PermissionId, { label: string; why: string }> = {
  microphone: { label: 'Microphone', why: 'Ridik cannot hear you without it.' },
  notifications: { label: 'Notifications', why: 'Reminders will not arrive.' },
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
  const toast = useToast();

  const state = permissions.data;
  if (!state) return null;

  // Both, always. The microphone is the product, and notifications carry every
  // reminder the app makes — a task falling due, arriving somewhere, a focus
  // phase ending. They stopped being conditional when the briefing stopped
  // being the only thing that used them.
  const needed: PermissionId[] = ['microphone', 'notifications'];

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

/* --------------------------------------------------------------- assistant */

/**
 * The one decision that lets anything leave this phone, and the way to change
 * it.
 *
 * A row rather than a switch, and that is the whole design. Turning consent
 * *off* is a one-tap act and a switch would do it fine; turning it back *on*
 * cannot be, because agreeing to something you are not being shown is not
 * agreement. Both directions therefore go through `/consent`, where the
 * disclosure is — and it is the same component the first run drew, so the
 * wording a decision is taken under cannot drift between the two screens where
 * it is taken.
 *
 * It passes this screen's own test, unlike almost everything on `/developer`:
 * set it to the worst value a stranger could pick and the app still works. The
 * worst value is "no", and "no" is a working app with an offline assistant.
 */
const CONSENT_COPY: Record<AssistantConsent, { value: string; action: string }> = {
  granted: {
    value: `The words of a request go to ${ASSISTANT_PROVIDER}. The audio never leaves this phone.`,
    action: 'Change',
  },
  declined: {
    value: 'Nothing is sent. Ridik files simple phrases on its own.',
    action: 'Turn on',
  },
  unset: { value: 'Not decided yet.', action: 'Read it' },
};

function AssistantGroup() {
  const nav = useNavigateOnce();
  const consent = useSetting('assistantConsent');
  const copy = CONSENT_COPY[consent.value];

  return (
    <Group title="Assistant">
      <Row
        icon={consent.value === 'granted' ? 'paper-plane-outline' : 'phone-portrait-outline'}
        label="Where your words go"
        value={copy.value}
        right={<Button label={copy.action} size="sm" onPress={() => nav.push('/consent')} />}
      />
    </Group>
  );
}

/* ------------------------------------------------------------------- voice */

function PreferencesGroup() {
  const tts = useSetting('ttsEnabled');
  return (
    <Group title="Preferences">
      <SwitchRow
        label="Speak replies"
        hint="Read confirmations and the briefing out loud."
        value={tts.value}
        onChange={tts.set}
      />
    </Group>
  );
}

/* ------------------------------------------------------------------ colour */

/**
 * The one preference that changes what the app looks like.
 *
 * It belongs on this screen and not behind the developer gate, by the test the
 * rest of the screen is held to: set it to the worst value you can and the app
 * still works. There is no worst value — every ember is held to the same
 * contrast rules as the default in `widget-tokens.test.ts`, which is what makes
 * this a choice rather than a way to make your own widgets unreadable.
 *
 * The swatch is the family's own primitive rather than a dot: one colour at four
 * opacities *is* the visual system, and it is what changes. It is drawn in the
 * scheme currently on screen, because that is the one the user is looking at.
 */
function ColourGroup() {
  const ember = useEmber();

  return (
    <Group title="Colour">
      {ember.options.map((option) => (
        <EmberRow
          key={option.name}
          option={option}
          selected={option.name === ember.value}
          onSelect={() => ember.set(option.name)}
        />
      ))}
    </Group>
  );
}

function EmberRow({
  option,
  selected,
  onSelect,
}: {
  option: EmberOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const { colors, scheme, spacing, radius } = useTheme();
  const ramp = option[scheme];
  const press = usePressScale({ scale: 0.98 });

  return (
    <AnimatedPressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={option.label}
      accessibilityHint={option.note}
      onPress={onSelect}
      {...press.handlers}
      style={[{ backgroundColor: selected ? colors.accentMuted : 'transparent' }, press.style]}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          padding: spacing.md,
          gap: spacing.md,
        }}
      >
        <View style={{ flexDirection: 'row', gap: 2 }}>
          {[ramp.cold, ramp.low, ramp.mid, ramp.hot].map((fill, index) => (
            <View
              key={index}
              style={{ width: 9, height: 22, borderRadius: radius.sm / 5, backgroundColor: fill }}
            />
          ))}
        </View>
        {/* `flex: 1` and not its own content: Android measures a text in a flex
            row short and clips it rather than wrapping. */}
        <View style={{ flex: 1, gap: 1 }}>
          <Txt variant="body">{option.label}</Txt>
          <Txt variant="micro" tone="tertiary">
            {option.note}
          </Txt>
        </View>
        {selected ? <Ionicons name="checkmark-circle" size={20} color={colors.accent} /> : null}
      </View>
    </AnimatedPressable>
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
