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
import { useMemo, useState } from 'react';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';

import { createLogger } from '@/core/logger';
import { useAssistantMode } from '@/hooks/useAssistant';
import { mergeTrial, useEntitlement, useTrialLedger } from '@/hooks/useBilling';
import { useSetSettings, useSettings } from '@/hooks/useSettings';
import {
  ANALYTICS_PROVIDER,
  ASSISTANT_PROVIDER,
  CRASH_PROVIDER,
  STORE_PROVIDER,
  STT_PROVIDER,
  WHISPER_PROVIDER,
  type AssistantConsent,
} from '@/llm/consent';
import { defaultSettings } from '@/repositories/settings';
import { describeTrial, trialSpent } from '@/services/billing/allowance';
import { isStoreBuild } from '@/services/billing/entitlement';
import { HeatField } from '@/ui/HeatField';
import { useTheme } from '@/ui/ThemeProvider';
import { useFontsReady } from '@/ui/fonts';
import { AnimatedPressable, usePressScale, useStaggeredEntry } from '@/ui/motionHooks';
import { Button, Card, Txt, useToast } from '@/ui/components';

import { consentPatch } from './gate';

const log = createLogger('consent-screen');

type Panel = {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
  /**
   * The enumeration, when there is one, drawn as lines rather than as clauses.
   *
   * This is where the real length was. The index Google is sent is a *list* of
   * six or seven things, and it was written as one sixty-word sentence held
   * together by semicolons — accurate, unreadable, and impossible to skim for
   * the one item you actually wanted to check. Nothing was cut to make these:
   * every category in the old sentence is a line here, which is why the screen
   * reads shorter while saying the same amount.
   */
  items?: readonly string[];
  /** The sentence after the list. */
  tail?: string;
  /**
   * Whether this panel is the disclosure or the elaboration.
   *
   * The two visible ones are the two that name a recipient: the assistant, and
   * the dictation service the audio reaches when the phone has no offline
   * voice. Those are what a person is actually deciding about, and moving
   * either behind a tap would make this a screen that asks for consent without
   * saying what to — the specific thing Guideline 5.1.2(i) rejects for.
   *
   * The other two are true and reassuring rather than load-bearing: what stays
   * (summarised in the heading above them) and what is never sent. They open on
   * request.
   *
   * The visible half must not be a *shorter* version of the enumeration: a
   * summary like "your event and task titles, list and habit names" would drop
   * the timetable's places, task due dates, projects, note titles and spending
   * categories. Understating is the failure mode here, so the panel body is used
   * verbatim in both places.
   */
  disclosure?: true;
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
 * **Every sentence here is checked against the code.** `buildLlmContext` puts
 * today's *and* tomorrow's event titles, times and locations, the timetable,
 * open tasks with due dates and projects, note titles, list names, habit
 * names, place labels, spending categories and up to twenty-five people's
 * names into the system prompt on every request, so the panels list all of it
 * rather than "the words of a request". Likewise the recording: on a phone
 * with no offline voice for the locale — the normal state on most Android
 * devices — recognition streams audio to a speech server, so that recipient is
 * named, and the gate in `pipeline.ts` keeps it on-device when consent is
 * refused. A disclosure that understates is worse than none: it is the thing
 * the grant was obtained with.
 */
const PANELS: Panel[] = [
  {
    icon: 'phone-portrait-outline',
    title: 'Stays on this phone',
    body:
      'Your calendar, tasks, notes, lists, spending and people live in one file on this device. ' +
      'Ridik also counts how you use it — how many turns, which tools ran, what failed, how long ' +
      'it took — in that same file. You can read that under Usage and clear it whenever you ' +
      'like; none of it is sent, and none of it is what you said. The file is part of your ' +
      "phone's own backup, so with iCloud or Google backup on, a copy sits in your account and " +
      'comes back when you restore a new phone.',
  },
  {
    icon: 'paper-plane-outline',
    disclosure: true,
    title: `Goes to ${ASSISTANT_PROVIDER}`,
    body:
      `Your request, today's date, and a short index of your own labels — enough for ` +
      `${ASSISTANT_PROVIDER} to work out what you meant by "Thursday" or "the robotics lab":`,
    items: [
      'Your calendar today and tomorrow, and your timetable, with times and places',
      'Your open tasks and when they are due',
      'The names of your projects, notes, lists, habits, places, spending categories and the people you keep track of',
    ],
    tail: `${ASSISTANT_PROVIDER} answers with what to do. Ridik does it here.`,
  },
  {
    icon: 'mic-outline',
    disclosure: true,
    title: 'The recording',
    body:
      'Your phone transcribes on its own whenever it has an offline voice for your language. ' +
      "When it has none, the audio goes to the same dictation service your keyboard's microphone " +
      'uses. Say no below and it never does — Ridik asks you to type instead. Either way, no ' +
      'recording is kept.',
  },
  {
    icon: 'lock-closed-outline',
    title: 'Never sent',
    body:
      'What is written inside a note. What anything cost. A phone number, an address, or where ' +
      'you have been. Only the labels listed above ever leave, and only so the assistant can ' +
      'tell one of your things from another. The counts are not part of that: they record that ' +
      'something happened, never what it was.',
  },
];

/** What a person must read before deciding. */
const DISCLOSURE = PANELS.filter((panel) => panel.disclosure);
/** True, reassuring, and one tap away. */
const REST = PANELS.filter((panel) => !panel.disclosure);

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
  /*
   * `plan.known`, which this screen was missing and `app/settings.tsx` was not.
   *
   * `UNKNOWN` means the store could not be asked, not that nothing was bought.
   * Without this check a paying subscriber opening `/consent` on a bad
   * connection was told they had "25 of 25 free requests left, then Ridik asks
   * you to pick a plan" — the exact lie `Entitlement.known` exists to prevent,
   * on the one screen where somebody decides whether to send their data.
   *
   * Silence is not the answer either: an unknown-and-actually-free user gets a
   * trial, and this is the screen where they should hear about it. So the
   * unknown case says what is true — that the store could not be reached and
   * free use is limited — rather than either a number or nothing.
   */
  const answered = plan !== undefined;
  const storeBuild = isStoreBuild() || values.simulateStoreBuild;
  const showTrial = answered && plan.known && !plan.active && storeBuild;
  const storeUnreachable = answered && !plan.known && storeBuild;
  /*
   * Both halves of the ledger, not just the database one.
   *
   * The settings rows are the working copy; the keychain holds the durable
   * mirror that survives a reinstall. Reading only the first told somebody who
   * had spent their whole trial that they had all of it left.
   */
  const durable = useTrialLedger();
  const trialLedger = mergeTrial(durable.data, {
    requestsUsed: values.llmTrialRequestsUsed,
    tokensUsed: values.llmTrialTokensUsed,
  });

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
        {/*
          The promise first, the disclosure second, the enumeration on request.

          This screen used to open with "Where your words go" over four cards
          holding about five hundred words of prose, and it is the first thing a
          new install ever sees. Every sentence in it is accurate and hard-won —
          two of them used to be *wrong*, and the docblock on `PANELS` records
          what that cost — so none of them have been cut. What changed is which
          of them a person has to read before they can decide.

          The lead is now the thing that is actually true and actually rare: no
          account, and your life in a file on your phone. That is the product's
          best claim, and it was being delivered in the register of a terms of
          service. Under it, the one sentence Guideline 5.1.2(i) and Play's
          prominent-disclosure rule require — what leaves, to whom, and why —
          which stays visible and unexpandable. The full enumeration is one tap
          away and everything in it is still exact.

          A note for anyone tempted to trim further: the *disclosure* is the
          visible half. Moving "goes to Google" behind the expander would make
          this a screen that asks for consent without stating what to, which is
          the specific thing the guideline rejects for.
        */}
        <Animated.View entering={arrive(0)} style={{ gap: spacing.xs }}>
          <Txt variant="eyebrow" tone="tertiary">
            {granted ? 'YOUR WORDS' : 'BEFORE YOU START'}
          </Txt>
          <Txt variant="display" accessibilityRole="header">
            Your life stays on this phone
          </Txt>
          <Txt variant="body" tone="secondary">
            No account, nothing to sign in to. Your calendar, tasks, notes, lists and spending
            live in one file on this device, and you can export or erase all of it whenever you
            like.
          </Txt>
        </Animated.View>

        {DISCLOSURE.map((panel, index) => (
          <Animated.View key={panel.title} entering={arrive(index + 1)}>
            <PanelCard panel={panel} />
          </Animated.View>
        ))}

        <Animated.View entering={arrive(DISCLOSURE.length + 1)}>
          <Disclosure />
        </Animated.View>

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
          ) : storeUnreachable ? (
            /* The store could not be asked. Saying nothing on the one screen
               where somebody decides to send their data is a worse disclosure
               than saying so — an unknown-and-actually-free user does get a
               trial, and should hear that free use is limited. */
            <Txt variant="micro" tone="tertiary">
              Ridik could not reach the store to check whether you have a plan. Free use of the
               assistant is limited; if you have already subscribed, nothing changes.
            </Txt>
          ) : null}
          {/* Every other recipient, by name. "The optional Whisper
              transcription" named a model rather than a company, and the
              briefing push was not mentioned at all — while one grant quietly
              covered all three. A grant is only informed if everybody it
              covers is on the screen it was given on. The last two arrived
              with the usage ledger and are the only ones the user has to
              switch on rather than merely leave alone; the sentence says so,
              because "optional" and "off right now" are different promises. */}
          <Txt variant="micro" tone="tertiary">
            There is no account. Four optional extras also need this permission, and each is off
            or unconfigured until you set it up: better transcription, which uploads the recording
            to {STT_PROVIDER} or to {WHISPER_PROVIDER}, each with a key you paste in yourself; and
            — only if you switch on Help improve Ridik in Settings, which is off — a count of what
            you did, never what you said, to {ANALYTICS_PROVIDER}, along with crash reports to{' '}
            {CRASH_PROVIDER}.
          </Txt>
          {/* Two recipients nobody opts into, and the reason this paragraph
              stopped claiming the optional four were "the only other things
              that can leave this phone". They are not extras and not behind
              this grant — a store build talks to the store, and saving a place
              asks the phone's own maps service what is at those coordinates —
              but the rule is that every recipient is named here, not every
              optional one. */}
          <Txt variant="micro" tone="tertiary">
            Two more are not optional and are not covered by this decision: buying a subscription
            sends the receipt and an anonymous installation id to {STORE_PROVIDER} and to your app
            store, and saving a place sends those coordinates to your phone&apos;s own maps service
            to get a street name back. Neither ever carries a note, a task or what you said.
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

/** One panel. Used verbatim above the fold and inside the expander. */
function PanelCard({ panel }: { panel: Panel }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <Card style={{ gap: spacing.sm }}>
      <View style={styles.panelHead}>
        <View
          style={[styles.glyph, { backgroundColor: colors.accentMuted, borderRadius: radius.sm }]}
        >
          <Ionicons name={panel.icon} size={17} color={colors.accent} />
        </View>
        {/* `flex: 1` and not its own content: Android measures a Text in a flex
            row short and clips it rather than wrapping. */}
        <Txt variant="heading" accessibilityRole="header" style={styles.panelTitle}>
          {panel.title}
        </Txt>
      </View>
      <Txt variant="caption" tone="secondary">
        {panel.body}
      </Txt>
      {panel.items ? (
        <View style={{ gap: 4 }}>
          {panel.items.map((item) => (
            <View key={item} style={styles.item}>
              {/* A dot rather than a bullet glyph: the character renders at a
                  different weight in every fallback face, and this list has to
                  look the same on both platforms. */}
              <View style={[styles.dot, { backgroundColor: colors.accent }]} />
              <Txt variant="caption" tone="secondary" style={{ flex: 1 }}>
                {item}
              </Txt>
            </View>
          ))}
        </View>
      ) : null}
      {panel.tail ? (
        <Txt variant="caption" tone="secondary">
          {panel.tail}
        </Txt>
      ) : null}
    </Card>
  );
}

/**
 * The rest, on request.
 *
 * Every word of `PANELS` is still here and still exact — this is a change of
 * *order*, not of content. What a person must read to decide is above; what
 * they may want to read is behind this, and it opens in place rather than on
 * another screen so the decision and the detail are never separated by
 * navigation.
 *
 * It is not a link out to a policy. A privacy policy on the web is a different
 * document with a different audience, and a consent screen that outsources its
 * own explanation to a browser is one where the grant is obtained without the
 * disclosure being read at all.
 */
function Disclosure() {
  const { colors, radius, spacing } = useTheme();
  const [open, setOpen] = useState(false);
  const press = usePressScale({ scale: 0.99 });

  return (
    <View style={{ gap: spacing.sm }}>
      <AnimatedPressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? 'Hide the detail' : 'Read exactly what is sent and what never is'}
        onPress={() => setOpen((current) => !current)}
        {...press.handlers}
        style={[
          styles.more,
          { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md },
          press.style,
        ]}
      >
        <Ionicons name="document-text-outline" size={17} color={colors.accent} />
        <Txt variant="bodyStrong" style={{ flex: 1 }}>
          Exactly what is sent, and what never is
        </Txt>
        <Ionicons
          name={open ? 'chevron-up' : 'chevron-down'}
          size={16}
          color={colors.textSecondary}
        />
      </AnimatedPressable>

      {open ? REST.map((panel) => <PanelCard key={panel.title} panel={panel} />) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  more: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  // Nudged to sit on the first line's optical centre rather than its box.
  dot: { width: 4, height: 4, borderRadius: 2, marginTop: 7 },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  glyph: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  panelTitle: { flex: 1 },
});
