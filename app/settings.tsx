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
import { Linking, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';

import { createLogger } from '@/core/logger';
import { now } from '@/core/clock';
import { clockFormatOptions, formatDayHeading, sampleClock } from '@/core/time';
import type { ConfirmMode } from '@/llm/confirm';
import {
  Group,
  ROW_LEAD,
  ReserveRowLead,
  GroupSkeleton,
  RetryRow,
  Row,
  SwitchRow,
} from '@/features/settings';
import { useEmber, useSetting } from '@/hooks';
// The module rather than the barrel: this one is a single `Platform` check,
// and `@/voice` reaches `expo-speech-recognition` on the way in.
import { canCaptureAudio } from '@/voice/capability';
import { useSecret } from '@/hooks/useSystem';
import { mergeTrial, useEntitlement, useTrialLedger } from '@/hooks/useBilling';
import {
  ANALYTICS_PROVIDER,
  ASSISTANT_PROVIDER,
  CRASH_PROVIDER,
  type AssistantConsent,
} from '@/llm/consent';
import { initialiseCrashReporting, stopCrashReporting } from '@/services/analytics/crash';
import { describeTrial, trialSpent } from '@/services/billing/allowance';
import {
  describePlan,
  describeRenewal,
  isStoreBuild,
  FREE,
} from '@/services/billing/entitlement';
import {
  useCalendarConnection,
  useConnectCalendar,
  useDisconnectCalendar,
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
      {/* Some cards here carry icons and some do not; the leading column is
          reserved across all of them so the labels share one left edge down
          the whole screen. See `ROW_LEAD`. */}
      <ReserveRowLead>
      <ErrorBoundary label="profile: plan">
        <PlanGroup />
      </ErrorBoundary>
      <ErrorBoundary label="profile: attention">
        <AttentionGroup />
      </ErrorBoundary>
      <ErrorBoundary label="profile: assistant">
        <AssistantGroup />
      </ErrorBoundary>
      <ErrorBoundary label="profile: calendar">
        <CalendarGroup />
      </ErrorBoundary>
      <ErrorBoundary label="profile: colour">
        <ColourGroup />
      </ErrorBoundary>
      <ErrorBoundary label="profile: clock">
        <ClockGroup />
      </ErrorBoundary>
      <ErrorBoundary label="profile: confirmations">
        <ConfirmGroup />
      </ErrorBoundary>
      <ErrorBoundary label="profile: listening">
        <ListeningGroup />
      </ErrorBoundary>
      <ErrorBoundary label="profile: replies">
        <RepliesGroup />
      </ErrorBoundary>
      <ErrorBoundary label="profile: data">
        <ImproveGroup />
        <DataGroup />
      </ErrorBoundary>
      <ErrorBoundary label="profile: about">
        <AboutGroup unlocked={developer.value} onUnlock={() => developer.set(true)} />
      </ErrorBoundary>
      </ReserveRowLead>
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
  // Read-only, and it must stay that way: `reset-surfaces.test.ts` fails the
  // build if anything in the app can write a trial counter. The number is
  // monotonic by design — nothing here may lower it.
  const trialUsed = useSetting('llmTrialRequestsUsed');
  // The trial's *other* ceiling, and the row is a lie without it. Six long
  // dictations, two of them repaired, spend the token allowance in six requests
  // — `resolveAssistantBudget` then refuses every turn with "this install has
  // used its free assistant allowance" while this row cheerfully reads "19 of
  // 25 free requests left". The one row that exists so a free user is not
  // misled about the limit has to know about both of them.
  const trialTokens = useSetting('llmTrialTokensUsed');
  const simulateStore = useSetting('simulateStoreBuild');
  /* Both stores. The settings rows are the working copy and the keychain holds
     the durable mirror — reading only the first told somebody who had spent
     their whole trial, deleted the app and reinstalled that they had all 25
     left. `useTrialLedger` also heals the rows upward as it reads.

     Up here with the other hooks, and it has to stay here. It used to sit below
     the loading return, which is a conditional hook: the first render ran four
     hooks and returned the skeleton, the second ran five, and React refused the
     component outright — "Rendered more hooks than during the previous render."
     Every render of this screen goes through that transition, because the
     entitlement is an async store read that has never resolved by the first
     frame. So the Plan row did not render at all; it was caught by the error
     boundary and replaced with its failure card, which is to say the one row
     that tells a free user their trial has a limit was the one row nobody could
     see. */
  const durable = useTrialLedger();

  if (entitlement.isLoading && !entitlement.data) return <GroupSkeleton title="Plan" rows={1} />;

  const plan = entitlement.data ?? FREE;
  const renewal = describeRenewal(plan, (at) => formatDayHeading(at, undefined, now()));

  /*
   * The free trial, said out loud on the one screen a person looks at to find
   * out what they are on.
   *
   * It has existed since the money path was written and has been visible in
   * exactly two places: the developer screen behind seven taps, and the notice
   * that fires with five requests left. Which is to say a free user's first
   * news of a 25-request limit arrived at request twenty. That is the review
   * every voice app with a hidden trial collects — "misleads with limited free
   * trial… he doesn't specify the limit" — and it is earned.
   *
   * Held until the entitlement has actually answered, for the same reason
   * `ConsentScreen` holds it: `isStoreBuild()` is module state that only turns
   * true once a provider has registered, so asking during the first render of a
   * cold start reliably gets "no" and nothing would re-render to correct it.
   * `known` as well as `active`: a store that could not be reached is not
   * evidence that anybody is on a trial, and telling a subscriber in a tunnel
   * how many free requests they have left is the same lie in the other
   * direction.
   */
  const showTrial =
    entitlement.data !== undefined &&
    plan.known &&
    !plan.active &&
    (isStoreBuild() || simulateStore.value);
  const ledger = mergeTrial(durable.data, {
    requestsUsed: trialUsed.value,
    tokensUsed: trialTokens.value,
  });
  const spent = trialSpent(ledger);

  return (
    <Group title="Plan">
      <Row
        icon={plan.active ? 'checkmark-circle-outline' : 'sparkles-outline'}
        label={plan.active ? `${describePlan(plan)} · the assistant` : 'Free'}
        value={showTrial ? describeTrial(ledger) : undefined}
        hint={
          !showTrial
            ? renewal
            : spent
              ? 'They are spent, and nothing refills them. Ridik still listens and still files simple phrases on its own; a plan turns the full assistant back on.'
              : // The second ceiling, said in the one sentence a person reads
                // rather than left to surprise them. Not as a token count —
                // nobody was sold a token and the number means nothing — but
                // the fact that a very long dictation is not the same size as
                // a short one, which is what actually spends it early.
                'They are for the life of this install, not per month, and very long dictations use more of the allowance than short ones. Everything else in Ridik stays free and unlimited.'
        }
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
    value:
      `The words of a request go to ${ASSISTANT_PROVIDER}. Your phone turns speech into text ` +
      `itself when it can; when it cannot, the audio goes to the dictation service instead.`,
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

/* ---------------------------------------------------------------- calendar */

/**
 * Connecting Google Calendar.
 *
 * It belongs on this screen for the same reason "Where your words go" does: it
 * is not a preference, it is a second place the user's data lives, and the one
 * question a stranger could get wrong — connect or not — has a working app on
 * both sides of it.
 *
 * It spent a while behind the developer gate, on the reasoning that it is a
 * one-time setup act rather than a preference. Both halves were true and the
 * conclusion was still wrong, because the calendar screen draws a banner that
 * says "Google Calendar isn't connected" and sends you *here* to fix it — so
 * the app was advertising a destination that did not exist for anybody who had
 * not tapped Version seven times. The confusion it caused is worth recording:
 * events mirrored to the phone's own calendar show up in Samsung Calendar,
 * which is itself synced to Google, so the app looked connected while nothing
 * had ever reached Google at all. See the note in `nativeCalendar.ts` about the
 * mirror being a LOCAL calendar.
 *
 * "Show in your phone calendar" used to sit beside it and is gone: it was never
 * a preference at all, only a mirror of an OS permission that the app now asks
 * for at the point it needs it.
 */
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
            : // Not "stay on this phone": they do reach the phone's own
              // calendar, which is exactly what made this confusing — that
              // calendar is displayed by Samsung Calendar and Google Calendar,
              // both of which sync to Google, while the events themselves never
              // did. See the note in `SyncBanner`.
              'Events reach your phone’s own calendar, but not Google, until you connect.'
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
                  onError: (error: Error) => toast.show({ message: error.message, tone: 'danger' }),
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
                  onError: (error: Error) => toast.show({ message: error.message, tone: 'danger' }),
                })
              }
            />
          )
        }
      />

    </Group>
  );
}

/* ---------------------------------------------------------------- replies */

/**
 * Speaking replies, back on this screen because the first run now asks about it.
 *
 * `AGENTS.md` records it being moved to `/developer` — off for the life of the
 * app, and reunited there with the `ttsRate` slider it had been separated from.
 * That reasoning was sound while nothing ever raised the subject: an inert
 * switch behind seven taps costs nobody anything.
 *
 * It stops being sound the moment the welcome flow asks the question. A person
 * who says yes on their first run and wants it off an hour later would have to
 * find a screen they have never seen, through a gesture nobody has told them
 * about — which is a worse outcome than the row this screen was protecting
 * itself from. **Anything onboarding asks, Settings has to be able to change.**
 *
 * The *rate* slider stays on `/developer`, which keeps the original point
 * intact: the knob that can make speech unlistenable is still a developer's,
 * and only the yes/no a stranger can answer is here.
 */
function RepliesGroup() {
  const speak = useSetting('ttsEnabled');

  return (
    <Group title="Replies">
      <SwitchRow
        label="Read answers out loud"
        hint="Off is quieter and faster. On is better with your hands full."
        value={speak.value}
        onChange={speak.set}
      />
    </Group>
  );
}

/* -------------------------------------------------------------- listening */

/**
 * Which engine turns speech into text — and only the ones that can run.
 *
 * An option is listed when it is genuinely available, never as an
 * advertisement: AssemblyAI needs a key in the keychain, and the offline model
 * needs a recogniser that can hand over the audio it heard, which is Android
 * 13+ (`canCaptureAudio`). With neither available there is one option, which is
 * not a choice, so the whole group goes.
 *
 * **The notes are the substance of the row and they say two things: who hears
 * it, and what it costs.** Never engine names alone — "AssemblyAI" means
 * nothing to the person deciding, and the thing they are actually choosing
 * between is a recording leaving the phone or not.
 *
 * They no longer say the upload engine costs the live caption, because on the
 * phones where these options appear it does not: the recogniser still runs and
 * still draws the words as they are said, and the second engine only rewrites
 * what gets filed. That was the whole point of `upgrade`.
 */
function ListeningGroup() {
  const engine = useSetting('sttEngine');
  const key = useSecret('assemblyai');
  const { colors } = useTheme();

  const options = STT_ENGINES.filter((option) => {
    if (option.value === 'assemblyai') return key.data?.present === true;
    if (option.value === 'whisper-local') return canCaptureAudio();
    return true;
  });
  if (options.length < 2) return null;

  return (
    <Group title="How it listens">
      {options.map((option) => {
        const selected = option.value === engine.value;
        return (
          <Row
            key={option.value}
            label={option.label}
            value={option.note}
            right={
              selected ? <Ionicons name="checkmark" size={18} color={colors.accent} /> : undefined
            }
            onPress={() => engine.set(option.value)}
          />
        );
      })}
    </Group>
  );
}

const STT_ENGINES: {
  value: 'device' | 'assemblyai' | 'whisper-local';
  label: string;
  note: string;
}[] = [
  {
    value: 'device',
    label: 'This phone',
    note: 'Free and instant, and the words appear as you say them. Loses more of them in a noisy room.',
  },
  {
    value: 'whisper-local',
    label: 'This phone, more carefully',
    note: 'Reads it again after you stop and corrects what it got wrong — on the phone, with nothing sent anywhere. Works with no signal. Needs a one-off 57 MB download, and does nothing on a phone whose own dictation is already this good.',
  },
  {
    value: 'assemblyai',
    label: 'AssemblyAI',
    note: 'The best of the three in a noisy room. The recording is uploaded to AssemblyAI, so it needs a signal and costs a little each time.',
  },
];

/* ----------------------------------------------------------- confirmations */

/**
 * How much Ridik shows you before it writes — and until now, nothing set it.
 *
 * `confirmMode` has existed since the executor did, with a documented default
 * of `irreversible` and **no UI anywhere in the app**: not on this screen, not
 * behind the developer gate. So a user who found the questions too frequent had
 * no way to say so, which is not a preference being withheld, it is a setting
 * that shipped inert.
 *
 * It passes this screen's test in the strongest way available: the app works at
 * every value. `never` is the receipt doing the job it was built for —
 * `LastAction` catches the mis-heard word after the fact, which is the whole
 * reason speaking is safe. `always` is somebody who wants to see every write
 * first. Neither can break anything, and only the middle one is a judgement
 * call about which writes deserve a question.
 *
 * What no value here reaches is the handlers' own questions. A clash, a
 * deletion with dependents, an ambiguous match — those are asked because the
 * app looked at the *stored data* and found something the user could not have
 * known when they spoke. Turning the review gate off says "I trust you heard
 * me"; it does not say "delete whatever you think I meant".
 */
function ConfirmGroup() {
  const mode = useSetting('confirmMode');
  const { colors } = useTheme();

  return (
    <Group title="Before it writes">
      {CONFIRM_MODES.map((option) => {
        const selected = option.value === mode.value;
        return (
          <Row
            key={option.value}
            label={option.label}
            value={option.note}
            right={
              selected ? <Ionicons name="checkmark" size={18} color={colors.accent} /> : undefined
            }
            onPress={() => mode.set(option.value)}
          />
        );
      })}
    </Group>
  );
}

const CONFIRM_MODES: { value: ConfirmMode; label: string; note: string }[] = [
  {
    value: 'never',
    label: 'Just do it',
    note: 'No questions. The receipt on the home screen is how you catch a mistake.',
  },
  {
    value: 'irreversible',
    label: 'Ask about what cannot be undone',
    note: 'Deletes and money get a question. Everything else lands and can be undone.',
  },
  { value: 'always', label: 'Ask every time', note: 'Every write is shown before it happens.' },
];

/* ------------------------------------------------------------------- clock */

/**
 * Twelve-hour or twenty-four, said out loud rather than inferred.
 *
 * `auto` reads the device and is right almost always, which is exactly why the
 * other two rows have to exist: `Intl` resolves from the *locale*, and
 * Android's "Use 24-hour format" system switch is not part of one — so an
 * American on an Android phone had no way to be shown AM/PM at all, and the
 * app disagreed with its own widgets, which have read
 * `DateFormat.is24HourFormat` since they shipped.
 *
 * Each row carries the same instant rendered its own way, because the label
 * "12-hour" is a specification and `9:41 PM` is the answer. It passes the
 * screen's test with room to spare: the worst value a stranger can pick is a
 * working app whose clock reads the other way round.
 */
function ClockGroup() {
  const format = useSetting('clockFormat');
  const { colors } = useTheme();
  const at = now();

  return (
    <Group title="Clock">
      {clockFormatOptions().map((option) => {
        const selected = option.value === format.value;
        return (
          <Row
            key={option.value}
            label={option.label}
            value={sampleClock(option.value, at)}
            right={
              selected ? <Ionicons name="checkmark" size={18} color={colors.accent} /> : undefined
            }
            onPress={() => format.set(option.value)}
          />
        );
      })}
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
        {/* Drawn to `ROW_LEAD`, not to its own taste: four cells of 4 with 2dp
            between them is exactly the 22 every other row's icon sits in, so
            `Ember` starts at the same x as `Microphone` two cards above it. A
            42dp swatch would have been the other way round — one row widening
            the column for the whole screen. */}
        <View style={{ width: ROW_LEAD, flexDirection: 'row', gap: 2 }}>
          {[ramp.cold, ramp.low, ramp.mid, ramp.hot].map((fill, index) => (
            <View
              key={index}
              style={{ width: 4, height: 22, borderRadius: radius.sm / 5, backgroundColor: fill }}
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

/* ------------------------------------------------------ help improve ridik */

/**
 * The one switch that turns an outbound path on, and the only row on this
 * screen that does.
 *
 * It passes the test the rest of the screen is held to — set it to its worst
 * value and the app still works; the only casualty is that the operator learns
 * nothing — which is why it is here and not behind the developer gate.
 *
 * Three things the copy has to do, and all three are load-bearing:
 *
 * - **Say what is sent by pointing at it.** "See exactly what" opens `/usage`,
 *   which lists the actual rows. A description of a payload is a claim; the
 *   payload is evidence, and `upload.ts` sends those rows unreshaped so the two
 *   cannot drift.
 * - **Name both recipients.** The counts go to the operator's own server; the
 *   crash reports go to Sentry, which is somebody else. One switch covering two
 *   recipients is only honest if both are named on it.
 * - **Admit what off cannot undo.** Turning it off stops the next batch. It
 *   does not recall what has already been sent, and saying so in one line is
 *   better than a promise that would need a server to keep.
 *
 * Writing the timestamp beside the flag is the same reasoning as
 * `assistantConsentAt`: "when did they choose this" is the record a privacy
 * review asks for, and it is the only way to tell a decision made under this
 * build's wording from one made under a future one.
 */
function ImproveGroup() {
  const router = useRouter();
  const optIn = useSetting('analyticsOptIn');
  const optInAt = useSetting('analyticsOptInAt');

  const onChange = (next: boolean) => {
    optIn.set(next);
    optInAt.set(now());
    // Sentry cannot be started or stopped by a settings row alone — it is a
    // native SDK with a process-wide handler — so the switch drives it here
    // rather than making the person relaunch to be taken at their word.
    if (next) void initialiseCrashReporting();
    else void stopCrashReporting();
  };

  return (
    <Group title="Help improve Ridik">
      <SwitchRow
        label="Send usage and crash reports"
        hint={
          `Sends the counts on the Usage screen — how many turns, which tools ran, what failed ` +
          `and how long it took — to ${ANALYTICS_PROVIDER}, and crash reports to ` +
          `${CRASH_PROVIDER}. Never what you said, never what you wrote, never a name or an ` +
          `amount. No account and no identifier: there is nothing in it that points back at ` +
          `this phone.`
        }
        value={optIn.value}
        onChange={onChange}
      />
      <Row
        icon="list-outline"
        label="See exactly what"
        hint={
          optIn.value
            ? 'Every row that would be sent, and a button to clear them. Turning this off stops the next batch; anything already sent cannot be recalled.'
            : 'Every row Ridik keeps about itself, on this phone. None of it leaves while this is off.'
        }
        right={<Chevron />}
        onPress={() => router.push('/usage')}
      />
    </Group>
  );
}

function DataGroup() {
  const exportAll = useExportEverything();
  const erase = useEraseAllData();
  const toast = useToast();
  const router = useRouter();
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
      {/* Readable and re-importable are two different promises, and the
          markdown above only makes the first one. With no account and no
          server, a backup is the only copy of this database that can ever
          come back. */}
      <Row
        icon="save-outline"
        label="Backup and restore"
        hint="A file that can be put back. Restoring adds; it never deletes."
        right={<Chevron />}
        onPress={() => router.push('/backup')}
      />
      {confirming ? (
        <View style={{ padding: spacing.md, gap: spacing.sm }}>
          <Txt variant="body" tone="danger">
            This empties every note, task, event, list and record Ridik keeps. There is no undo.
          </Txt>
          {/*
            The sentence this replaces said "there is no backup", which stopped
            being true the day Backup and restore shipped — and the row directly
            above says the opposite in as many words. Two screens in one app
            disagreeing about the same button is bad enough; the harm is
            somebody typing ERASE before selling the phone and leaving a
            plaintext JSON of every note, contact and transaction in the
            documents directory, because the button promised it went too.
            `wipeAllTables` only empties SQLite; it has never touched a file.
          */}
          <Txt variant="caption" tone="secondary">
            Backup files you have already saved are not touched — they are files, not rows. Delete
            those from “Backup and restore” above if this phone is leaving your hands.
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
