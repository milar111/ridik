/**
 * The one thing Ridik has to say before it listens.
 *
 * Ridik's promise is local-first — no account, no sign-in, one SQLite file on
 * the phone — and every word of that is true. The gap it never closed is that
 * the *assistant* is not local: the transcript of a request goes to Google to
 * be turned into actions. That is not a footnote to the promise, it is the one
 * exception to it, and a product that says "everything stays on your phone"
 * without saying it out loud has mis-sold itself.
 *
 * So this screen is written as an answer rather than a warning. It says what
 * stays, what goes, and what is never sent, in that order, because the order is
 * the reassurance: by the time anyone reads "goes to Google" they already know
 * how little that is. Nothing here is hedged and nothing is softened — a person
 * should finish it knowing more and feeling safer, and the fastest way to fail
 * at that is a scare word or a vague one.
 *
 * Two exits, both real. "Allow" is the product; "Use Ridik offline" is not a
 * punishment lane — every local feature works, and the offline pattern matcher
 * in `@/llm/provider/mock` still turns "spent 12 on lunch" and a plain note
 * into rows with no network at all. Neither answer is a dead end and either can
 * be changed later, which is said on the screen rather than left to be
 * discovered.
 *
 * Mounted twice, deliberately: `ConsentGate` draws it over the whole navigator
 * on a first run, and `app/consent.tsx` is the route Settings and every refusal
 * notice point at. One component, so the wording a decision was taken under
 * cannot drift between the two places it is taken.
 */
import { useMemo } from 'react';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';

import { createLogger } from '@/core/logger';
import { useAssistantMode } from '@/hooks/useAssistant';
import { useEntitlement } from '@/hooks/useBilling';
import { useSetSettings, useSettings } from '@/hooks/useSettings';
import {
  ASSISTANT_PROVIDER,
  PUSH_PROVIDER,
  WHISPER_PROVIDER,
  type AssistantConsent,
} from '@/llm/consent';
import { defaultSettings } from '@/repositories/settings';
import { describeTrial, trialSpent } from '@/services/billing/allowance';
import { isStoreBuild } from '@/services/billing/entitlement';
import { HeatField } from '@/ui/HeatField';
import { useTheme } from '@/ui/ThemeProvider';
import { useFontsReady } from '@/ui/fonts';
import { useStaggeredEntry } from '@/ui/motionHooks';
import { Button, Card, Txt, useToast } from '@/ui/components';

import { consentPatch } from './gate';

const log = createLogger('consent-screen');

type Panel = {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
};

/**
 * The disclosure itself, in the order that makes it read as an answer.
 *
 * What stays first, because it is nearly everything and it is the thing people
 * are actually asking about. What goes second, so it lands as the small
 * exception it is. Then the recording, because it is the one people assume is
 * uploaded — the app listens, so surely it does. Then what is never sent.
 *
 * `ASSISTANT_PROVIDER` rather than the word "Google" typed here: naming the
 * third party is the specific thing Guideline 5.1.2(i) requires, and a
 * disclosure that names one provider while the refusal notice names another is
 * worse than either alone.
 *
 * **Every sentence here is checked against the code, and two of them used to
 * fail.** "The words of a request, and today's date" described maybe a tenth of
 * what a turn sends: `buildLlmContext` puts today's *and* tomorrow's event
 * titles, times and locations, the timetable, open tasks with due dates and
 * projects, note titles, list names, habit names, place labels, spending
 * categories and up to twenty-five people's names from the CRM into the system
 * prompt on every single request — so "note the resistors" carried the user's
 * colleagues and their oncology appointment with it. And "Never sent — the
 * recording" was false whenever the phone had no offline voice for the locale,
 * which is the normal state on most Android devices: the session simply started
 * with `requiresOnDeviceRecognition: false` and streamed the audio to a speech
 * server. The gate in `pipeline.ts` now makes the refusal true, and these
 * panels say what the granted path actually does. A disclosure that understates
 * is worse than none: it is the thing the grant was obtained with.
 */
const PANELS: Panel[] = [
  {
    icon: 'phone-portrait-outline',
    title: 'Stays on this phone',
    body:
      'Your calendar, tasks, notes, lists, spending and the people you keep track of live in one ' +
      'file on this device. There is no account, nothing to sign in to, and no analytics.',
  },
  {
    icon: 'paper-plane-outline',
    title: `Goes to ${ASSISTANT_PROVIDER}`,
    body:
      `The words of your request, today's date, and a short index of your own labels, so ` +
      `${ASSISTANT_PROVIDER} can work out what you meant by "Thursday" or "the robotics lab": ` +
      'what is on your calendar today and tomorrow and what is on your timetable, with their ' +
      'times and places; your open tasks and when they are due; and the names of your projects, ' +
      'notes, lists, habits, places, spending categories and the people you keep track of. It ' +
      'answers with what to do; Ridik does it here.',
  },
  {
    icon: 'mic-outline',
    title: 'The recording',
    body:
      'Your phone turns speech into text itself whenever it has an offline voice for your ' +
      "language. When it has none, the words are dictated by the same service your keyboard's " +
      'microphone uses, and the audio goes there. Say no below and Ridik will not do that — it ' +
      'asks you to type instead. Either way Ridik keeps no recording.',
  },
  {
    icon: 'lock-closed-outline',
    title: 'Never sent',
    body:
      'What is written inside a note. What anything cost. A phone number, an address, or where ' +
      'you have been. Only the labels above ever leave, and only so the assistant can tell one ' +
      'of your things from another.',
  },
];

/** One line saying which way this particular build reaches the assistant. */
const ROUTE_COPY = {
  hosted: `Requests go to Ridik's server, which passes them to ${ASSISTANT_PROVIDER}.`,
  'personal-key': `Requests go straight to ${ASSISTANT_PROVIDER}, with the key stored on this phone.`,
  offline: `No assistant is set up yet, so nothing is being sent today. This decides what happens when one is.`,
} as const;

export type ConsentScreenProps = {
  /**
   * Called after a decision, and by "Done". The overlay leaves it off — it
   * disappears on its own the moment the setting stops being `unset` — and the
   * route uses it to go back where it came from.
   */
  onDone?: () => void;
};

export function ConsentScreen({ onDone }: ConsentScreenProps) {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const fontsReady = useFontsReady();
  const arrive = useStaggeredEntry({ from: 'below' });
  const toast = useToast();

  const settings = useSettings();
  const save = useSetSettings();
  const mode = useAssistantMode();
  const entitlement = useEntitlement();

  // The declared defaults while the read is in flight, exactly as `useSetting`
  // does it: this screen has no "unknown" state to render, and the one value it
  // branches on defaults to the safe answer anyway.
  const fallback = useMemo(() => defaultSettings(), []);
  const values = settings.data ?? fallback;
  const consent: AssistantConsent = values.assistantConsent;
  const granted = consent === 'granted';

  /**
   * The trial, on the builds that have one.
   *
   * Held until the entitlement has actually answered, because `isStoreBuild()`
   * is module state that only becomes true once a provider has registered —
   * asking it during the first render of a cold start reliably gets "no", and
   * nothing would re-render to correct it. The query landing is what does.
   */
  const plan = entitlement.data;
  const showTrial =
    plan !== undefined && !plan.active && (isStoreBuild() || values.simulateStoreBuild);
  const trialLedger = {
    requestsUsed: values.llmTrialRequestsUsed,
    tokensUsed: values.llmTrialTokensUsed,
  };

  const legal = (Constants.expoConfig?.extra ?? {}) as { legal?: { privacy?: string } };
  const privacy = legal.legal?.privacy;

  const decide = (decision: Exclude<AssistantConsent, 'unset'>) => {
    save.mutate(consentPatch(decision), {
      onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
    });
    onDone?.();
  };

  // Nothing may be laid out before the faces resolve: Android caches text
  // measurements, and this screen is the first one a new install ever sees, so
  // a paragraph measured in the fallback face would stay wrong for the session.
  if (!fontsReady) return <View style={[styles.root, { backgroundColor: colors.bg }]} />;

  return (
    <View style={styles.root} testID="consent-screen">
      {/* The app's own ground rather than a plain card: this is the first thing
          a new install draws, and it should be unmistakably the same object as
          the screen behind it. Idle, because nothing is listening yet. */}
      <HeatField state="idle" />

      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + spacing.xl,
          paddingBottom: insets.bottom + spacing.xl,
          paddingHorizontal: spacing.lg,
          gap: spacing.md,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Animated.View entering={arrive(0)} style={{ gap: spacing.xs }}>
          <Txt variant="eyebrow" tone="tertiary">
            {granted ? 'YOUR WORDS' : 'BEFORE YOU START'}
          </Txt>
          {/* Headers, so a screen reader can move through this by heading
              rather than swiping every paragraph of it. It is the longest
              screen in the app and the one nobody may skip. */}
          <Txt variant="display" accessibilityRole="header">
            Where your words go
          </Txt>
          <Txt variant="body" tone="secondary">
            Ridik keeps your life on this phone. To turn what you say into events, tasks and notes,
            it sends what you said — and a short index of your own labels — to {ASSISTANT_PROVIDER}.
          </Txt>
        </Animated.View>

        {PANELS.map((panel, index) => (
          <Animated.View key={panel.title} entering={arrive(index + 1)}>
            <Card style={{ gap: spacing.sm }}>
              <View style={styles.panelHead}>
                <View
                  style={[
                    styles.glyph,
                    { backgroundColor: colors.accentMuted, borderRadius: radius.sm },
                  ]}
                >
                  <Ionicons name={panel.icon} size={17} color={colors.accent} />
                </View>
                {/* `flex: 1` and not its own content: Android measures a Text in
                    a flex row short and clips it rather than wrapping. */}
                <Txt variant="heading" accessibilityRole="header" style={styles.panelTitle}>
                  {panel.title}
                </Txt>
              </View>
              <Txt variant="caption" tone="secondary">
                {panel.body}
              </Txt>
            </Card>
          </Animated.View>
        ))}

        <Animated.View entering={arrive(4)} style={{ gap: spacing.sm }}>
          {mode.data ? (
            <Txt variant="micro" tone="tertiary">
              {ROUTE_COPY[mode.data]}
            </Txt>
          ) : null}
          {/* The trial has been reachable only from the developer screen, behind
              seven taps on the version row — which is to say it has been told to
              nobody it was written for. This is where it belongs: the moment a
              person decides whether requests may be sent is the moment the
              number of them matters. */}
          {showTrial ? (
            <Txt variant="micro" tone="tertiary">
              {/* Both ceilings. The counter alone cannot say whether the
                  assistant is still on — the token allowance is spendable in
                  a handful of long turns — and "19 of 25 free requests left"
                  above a model that refuses every one of them is the same
                  hidden-trial complaint in a different place. */}
              {trialSpent(trialLedger)
                ? 'The free assistant allowance for this install is spent. Ridik asks you to pick a plan before it sends anything to the model.'
                : `${describeTrial(trialLedger)}, then Ridik asks you to pick a plan.`}
            </Txt>
          ) : null}
          {/* Both of the other recipients, by name. "The optional Whisper
              transcription" named a model rather than a company, and the
              briefing push was not mentioned at all — while one grant quietly
              covered all three. A grant is only informed if everybody it
              covers is on the screen it was given on. */}
          <Txt variant="micro" tone="tertiary">
            There is no account and no analytics. Two optional extras are the only other things that
            can leave this phone, and both need this permission too: Whisper transcription, which
            uploads the recording to {WHISPER_PROVIDER} with a key you paste in yourself; and the
            daily briefing notification, whose one line is handed to {PUSH_PROVIDER} to deliver.
          </Txt>
        </Animated.View>

        <Animated.View entering={arrive(5)} style={{ gap: spacing.sm, paddingTop: spacing.sm }}>
          {/* Both buttons say what they decide, not just what they are called.
              "Allow" heard on its own is an answer with the question missing,
              and this is the one decision in the app that cannot be taken back
              by undoing a row. */}
          <Button
            testID="consent-allow"
            label={granted ? 'Done' : 'Allow'}
            accessibilityHint={
              granted
                ? 'Closes this screen and leaves your answer as it is'
                : `Lets Ridik send what you say to ${ASSISTANT_PROVIDER}. You can change this later in Settings.`
            }
            variant="primary"
            size="lg"
            fullWidth
            onPress={() => (granted ? onDone?.() : decide('granted'))}
          />
          <Button
            testID="consent-decline"
            label={granted ? 'Stop sending' : 'Use Ridik offline'}
            accessibilityHint={`Nothing is sent to ${ASSISTANT_PROVIDER}. Ridik still files simple phrases on this phone.`}
            variant="ghost"
            size="md"
            fullWidth
            onPress={() => decide('declined')}
          />
          <Txt variant="micro" tone="tertiary" center>
            {granted
              ? 'You can stop this at any time. Everything already on this phone stays.'
              : 'Offline, Ridik still hears you and files simple phrases — or asks you to type, on a phone with no offline voice. You can change this in Settings whenever you like.'}
          </Txt>
          {privacy ? (
            <Button
              label="Privacy policy"
              accessibilityHint="Opens in your browser"
              variant="ghost"
              size="sm"
              fullWidth
              onPress={() =>
                void Linking.openURL(privacy).catch((error: unknown) => {
                  log.warn('could not open the privacy policy', error);
                  toast.show({ message: 'Could not open the privacy policy.', tone: 'danger' });
                })
              }
            />
          ) : null}
        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  glyph: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  panelTitle: { flex: 1 },
});
