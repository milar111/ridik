import { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';

import { useTheme } from '@/ui/ThemeProvider';
import { useAnnounceOnIOS } from '@/ui/a11y';
import { Txt } from '@/ui/components/Text';
import { Button } from '@/ui/components/Button';
import { Input } from '@/ui/components/Controls';
import { SheetCard } from '@/ui/components/SheetCard';
import { ThinkingDots } from '@/ui/components/ThinkingDots';
import { MIC_DOCK_RIGHT, MIC_GAP, MIC_SIZE } from '@/ui/layout';
import { SPRING_TAP } from '@/ui/motion';
import { AnimatedPressable, usePressScale, usePulse } from '@/ui/motionHooks';
import { elevate } from '@/ui/shadow';
import { useVoiceStore, type VoiceOutcomeItem } from './store';
import { UnsentTranscript } from './Unsent';
import { useQuickActionRouting } from './useQuickActions';

/**
 * The longest thing the typed box will accept — about 5,000 words, which is
 * far more than anyone dictates and still a bounded number of tokens.
 */
const MAX_DRAFT_CHARS = 20_000;

/**
 * How tall the composer may grow before its own words start scrolling.
 *
 * About six lines of `body`. The sheet also has to show the line saying what
 * the box is, the Send and Speak buttons and its grab handle, and a box that
 * grows without limit takes all three off the top of the screen — on the one
 * surface whose whole job is letting you fix a sentence and send it.
 */
const COMPOSER_MAX_HEIGHT = 148;

/**
 * What the review box says above the words.
 *
 * Two facts, in the order they matter: this is what was heard, and it has not
 * gone anywhere yet. The second is what makes the pause read as a checkpoint
 * rather than a stall — and it is literally true, which is the point of the
 * whole feature: nothing has been sent, so nothing has been charged for.
 *
 * It deliberately does not mention tokens, plans or trials. The reason to fix a
 * mis-heard word is that it is wrong; the saving is why this is on by default,
 * not why the user is being asked.
 */
const REVIEW_NOTE = 'Heard this — nothing sent yet. Fix anything that came out wrong.';

/**
 * The dock's own states, said rather than drawn.
 *
 * `error` is missing on purpose: the sheet already prints the failure, and that
 * sentence is the one announced. Two announcements for one event is the whole
 * "nothing announces twice" rule, and this is the place it would break first.
 */
const SPOKEN_STATUS: Record<string, string> = {
  listening: 'Listening. Tap to send.',
  thinking: 'Working on it.',
  speaking: 'Ridik is speaking.',
};

/**
 * The one control the whole product is built around: a single always-present
 * mic. Tap to talk, tap again to send early, long-press to type instead.
 */
export function VoiceDock() {
  useQuickActionRouting();
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const onHome = pathname === '/';

  const status = useVoiceStore((s) => s.status);
  const expanded = useVoiceStore((s) => s.expanded);
  const partial = useVoiceStore((s) => s.partial);
  const transcript = useVoiceStore((s) => s.transcript);
  const error = useVoiceStore((s) => s.error);
  const needsRetry = useVoiceStore((s) => s.needsRetry);
  const sttUnavailable = useVoiceStore((s) => s.sttUnavailable);
  const heardNothing = useVoiceStore((s) => s.heardNothing);
  const recovered = useVoiceStore((s) => s.recovered);
  const draftSeed = useVoiceStore((s) => s.draftSeed);
  const consumeDraftSeed = useVoiceStore((s) => s.consumeDraftSeed);
  const outcome = useVoiceStore((s) => s.outcome);
  const clarification = useVoiceStore((s) => s.pendingClarification);
  const startListening = useVoiceStore((s) => s.startListening);
  const stopListening = useVoiceStore((s) => s.stopListening);
  const submitText = useVoiceStore((s) => s.submitText);
  const close = useVoiceStore((s) => s.close);
  // Typing lives in the store, not here: the mic on home and the control beside
  // its caption both ask for the text box from outside this component, and on
  // home a sheet that is merely `expanded` renders nothing.
  const typing = useVoiceStore((s) => s.typing);
  const setTyping = useVoiceStore((s) => s.setTyping);
  const startTyping = useVoiceStore((s) => s.startTyping);

  const [draft, setDraft] = useState('');
  /**
   * Whether this box is holding a sentence back rather than replacing one.
   *
   * The difference is the whole of the copy. Every label here was written for
   * somebody typing because talking did not work — "Type what you would have
   * said", "Speak instead" — and putting a sentence the app *did* hear behind
   * those words reports a success as a failure. It also has to be sticky: the
   * seed that set it is consumed immediately, and the box stays up while the
   * word gets fixed.
   */
  const [reviewing, setReviewing] = useState(false);
  /**
   * Set when a yes/no question has been answered "No" and the correction is
   * being typed. It is *not* the same as `typing`: a pending question forces
   * the box open regardless, and without this the buttons and the keyboard
   * would be up at the same time, which asks a yes/no question and then puts a
   * text field under it — the exact thing this replaced.
   */
  const [correcting, setCorrecting] = useState(false);

  const listening = status === 'listening';
  // Buttons only where a yes is actually meaningful. An open question — the
  // model asking for a value it could not default — has no yes to give.
  const yesNo = clarification?.answers === 'yesno';

  /**
   * The listening pulse, on the shared loop rather than a hand-rolled sequence.
   *
   * `usePulse` cancels and settles to `from` — 1, the resting size — when it
   * stops, which is what the old `else` branch did by hand, and it also holds
   * the mic still for anyone who asked the OS to reduce motion. A `withRepeat`
   * cannot get that from a config: a repeat whose step resolves instantly still
   * repeats, forever, at speed.
   */
  // `ms` is one direction; `usePulse` reverses, so this is the same 620-out,
  // 620-back beat the mic already had.
  const pulse = usePulse({ from: 1, to: 1.14, ms: 620, active: listening });

  // Any completed utterance can touch any table; the cheapest correct thing is
  // to invalidate everything rather than guess which screens went stale.
  useEffect(() => {
    if (outcome && outcome.items.some((i) => i.ok)) {
      void queryClient.invalidateQueries();
    }
  }, [outcome, queryClient]);

  /*
    A pending question opens the sheet, but it no longer forces the keyboard up:
    a question with buttons under it is answered by tapping one. Only an open
    question — the model needing words it could not default — still needs the
    box from the start.
  */
  useEffect(() => {
    setCorrecting(false);
    if (clarification) setTyping(clarification.answers !== 'yesno');
  }, [clarification]);

  // Nothing to retry on a device with no recogniser, so go straight to the way
  // that does work rather than showing a "Try again" that never will.
  useEffect(() => {
    if (sttUnavailable) setTyping(true);
  }, [sttUnavailable]);

  /**
   * Text arriving from anywhere — the recovery card in this sheet, the one on
   * home (a different component entirely, which cannot reach this text box), or
   * a finished utterance held back for review. The store carries it between
   * them; the dock takes it.
   *
   * The reason is kept in its own state rather than read off `draftSeed`,
   * because the seed is consumed on the same tick and the box outlives it.
   */
  useEffect(() => {
    if (draftSeed == null) return;
    setDraft(draftSeed.text);
    setReviewing(draftSeed.reason === 'review');
    setTyping(true);
    consumeDraftSeed();
  }, [draftSeed, consumeDraftSeed]);

  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));
  // The disc is 56pt and the press sits *inside* the pulse, so the two scales
  // compose: the mic answers the finger without leaving the breath behind.
  const micPress = usePressScale({ scale: 0.94 });

  /**
   * On home the screen is already the voice interface — the field floods, the
   * ring pulses, the caption says what is happening, and the receipt shows the
   * result. Sliding a sheet and a scrim over all of that hides the one thing
   * the app is for. So here the sheet is reserved for the cases that genuinely
   * need it: a question to answer, a failure to retry, or typing.
   *
   * Everywhere else it opens as it always did; those screens have no other way
   * to show what happened.
   *
   * A notice counts as genuinely needing it. It is the sentence that says the
   * assistant has stopped calling the model — computed on the turn it happens
   * and, before this, rendered nowhere on the one screen most turns are taken
   * from. A quietly dumber assistant is exactly the failure the receipt exists
   * to prevent, and it is rare enough that opening the sheet costs nothing.
   *
   * And so does an answer. Everything else a turn produces is a *receipt* — one
   * line saying what was written, which is what `LastAction` draws in place. A
   * search is the one tool whose output is a set of rows, and it is reached by
   * asking a question rather than giving an order: the rows are the thing the
   * user wanted. On home they had nowhere to go, so the answer to "what have I
   * got about resistors" was "Found 6 matches" and no way to see them.
   */
  const answered = Boolean(outcome?.items.some((item) => item.results?.length));

  const needsSheet =
    Boolean(clarification) || Boolean(error) || typing || Boolean(outcome?.notice) || answered;
  const showSheet = expanded && (!onHome || needsSheet);

  /**
   * The failure, in the words the sheet prints — which is also the sentence a
   * screen reader is given, so the two can never drift apart.
   *
   * `heardNothing` outranks `needsRetry` because it is the more specific fact
   * and the softer wording is actively misleading over it: a session that
   * recorded no words at all is not "I didn't quite catch that", the user has
   * just spoken a paragraph into a microphone that kept none of it.
   */
  const errorLine = error
    ? heardNothing
      ? 'Nothing was recorded. Not one word of that reached the recogniser.'
      : needsRetry
        ? "I didn't catch that clearly. Try again?"
        : error
    : null;

  /**
   * The receipt, for the screens that have no `LastAction` under them.
   *
   * On home the card below the mic is the receipt and it announces itself; away
   * from home this list is the only report a turn ever gets, so a turn taken
   * from `/notes` landed in complete silence. Same sentence either way, because
   * it is the same promise: what happened, and how much else happened with it.
   */
  const applied = outcome?.items.filter((item) => item.ok) ?? [];
  const last = applied[applied.length - 1] ?? null;
  const receiptLine = last
    ? `Done. ${last.summary}` + (applied.length > 1 ? `, and ${applied.length - 1} more` : '')
    : null;

  /**
   * What a screen reader is told, and in what order.
   *
   * A question the user cannot hear is a question they will answer yes to, so
   * the clarification — which is also how the review gate previews a write
   * before it lands — outranks everything else on the sheet. Then the failure,
   * then the notice that says the assistant has quietly stopped calling the
   * model. One sentence per turn rather than three: iOS announcements made in
   * the same commit interrupt each other, and the one that survives would be
   * whichever happened to be last.
   *
   * The receipt and the status come last and only away from home, because on
   * home they belong to `HomeMic` and `LastAction` — this dock draws no mic
   * there and the card under it is the receipt. Both announcing would say
   * "Working on it" and then the same result twice.
   *
   * Each of these blocks also carries its own `accessibilityLiveRegion`, which
   * is the Android half; see `src/ui/a11y.ts` for why they are not the same
   * mechanism.
   */
  const spokenSheet = showSheet
    ? (clarification ? `Ridik asks: ${clarification.question}` : (errorLine ?? outcome?.notice ?? null))
    : null;
  useAnnounceOnIOS(
    spokenSheet ?? (onHome ? null : (receiptLine ?? SPOKEN_STATUS[status] ?? null)),
  );

  /**
   * Closing the sheet throws nothing away.
   *
   * A half-typed correction and a dictation the sheet was dismissed over are
   * the same thing to the person who wrote them, and the backdrop is a very
   * easy tap to make by accident. The draft goes into the store's one keeping
   * place; `UnsentTranscript` is the way back to it.
   *
   * Handed to `close()` rather than stashed with `keepDraft()` first: `close()`
   * recomputes the slot from the store's own `transcript`, so two calls meant
   * the older, un-edited sentence won and the correction the user had just
   * typed was thrown away. One call, and the newest words outrank the rest.
   */
  const dismiss = useCallback(() => {
    const kept = draft.trim();
    setDraft('');
    // `close()` owns `typing` now that it lives in the store, so there is one
    // place deciding what a dismissed sheet leaves behind. The *text* is still
    // local to this component, which is why it is passed in.
    close(kept || undefined);
  }, [close, draft]);

  /**
   * Drag the sheet away by its handle.
   *
   * Attached to the handle rather than the whole sheet on purpose: the results
   * list inside is a ScrollView, and a pan over the whole surface would fight
   * it for every vertical gesture. The handle is the affordance people already
   * reach for, and it cannot be ambiguous.
   *
   * The drag's offset is handed to `SheetCard`, which adds it to its own
   * entrance rather than stacking a second transform — so the sheet arrives the
   * way every other sheet in the app does and can still be pulled away, and a
   * pull that starts mid-rise moves the sheet the finger is actually on.
   */
  const sheetY = useSharedValue(0);
  useEffect(() => {
    if (showSheet) sheetY.value = 0;
  }, [showSheet, sheetY]);

  const dragToDismiss = Gesture.Pan()
    .onChange((event) => {
      // Downward only. Dragging a bottom sheet up should do nothing, not
      // detach it from the edge it is anchored to.
      sheetY.value = Math.max(0, sheetY.value + event.changeY);
    })
    .onEnd((event) => {
      // Either a long pull or a quick flick: a sheet that only closed on
      // distance ignores the fast flick everyone actually does.
      if (sheetY.value > 90 || event.velocityY > 700) runOnJS(dismiss)();
      else sheetY.value = withSpring(0, SPRING_TAP);
    });


  // The same element as the one on home: the darkest object on the screen,
  // constant, so the two mics read as one control that followed you here rather
  // than as a second, differently-coloured feature.
  const micColor = status === 'error' ? colors.danger : listening ? colors.accent : colors.text;
  // Same swap as `HomeMic`, for the same reason: a still ellipsis at the one
  // moment there is nothing to do but wait reads as a hung app. The two mics
  // are meant to be one control that followed you here, so they cannot animate
  // differently.
  const working = status === 'thinking';
  const micIcon: keyof typeof Ionicons.glyphMap = status === 'speaking' ? 'volume-high' : 'mic';

  const onPressMic = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    if (listening) void stopListening();
    else void startListening();
  };

  const onLongPressMic = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    startTyping();
  };

  /**
   * Send, and empty the box — but only for a send that will actually be taken.
   *
   * `submitText` refuses while a turn is still in flight, and the box stays
   * mounted through one whenever a clarification is pending, so "answer, model
   * is slow, retype, press Send" cleared the field and dropped the sentence
   * with nothing said about it. Holding the text here is the visible half; the
   * store keeps a refused sentence in `recovered` as well, because the keyboard
   * return key reaches this by a path no `disabled` can cover.
   */
  const send = () => {
    if (status === 'thinking') return;
    const text = draft;
    setDraft('');
    setReviewing(false);
    setTyping(false);
    void submitText(text);
  };

  return (
    <>
      {/* Home puts the mic in the middle of the screen at four times this size.
          A second one hovering in the corner would be the same session twice,
          and whichever the user pressed the other would look broken. */}
      {onHome ? null : (
        <View
          pointerEvents="box-none"
          // The tab bar it used to clear is gone, so the mic sits on the safe
          // area itself.
          style={[styles.dock, { bottom: insets.bottom + MIC_GAP }]}
        >
          {/* The way back to an unsent transcript once the sheet is gone. Only
              here: home draws its own, in the flow, where it cannot land on
              top of the receipt. */}
          {showSheet ? null : <UnsentTranscript maxWidth={280} />}

          <Animated.View style={pulseStyle}>
            <AnimatedPressable
              testID="voice-mic"
              accessibilityRole="button"
              accessibilityLabel={listening ? 'Stop listening' : 'Start voice capture'}
              accessibilityHint="Long press to type instead"
              // The glyph swap and the tint are the sighted half of this.
              accessibilityState={{ busy: status === 'thinking' || status === 'speaking' }}
              onPress={onPressMic}
              onLongPress={onLongPressMic}
              {...micPress.handlers}
              style={[
                styles.mic,
                // Tinted by the mic's own state colour, which Android's
                // `elevation` could never be told about — it only draws black.
                elevate('floating', micColor),
                { backgroundColor: micColor },
                micPress.style,
              ]}
            >
              {working ? (
                <ThinkingDots color={colors.surface} size={6} gap={4} />
              ) : (
                <Ionicons name={micIcon} size={26} color={colors.surface} />
              )}
            </AnimatedPressable>
          </Animated.View>

          {listening && partial ? (
            <View
              style={[
                styles.partial,
                { backgroundColor: colors.surfaceRaised, borderColor: colors.border, borderRadius: radius.pill },
              ]}
            >
              <Txt variant="caption" numberOfLines={1}>
                {partial}
              </Txt>
            </View>
          ) : null}
        </View>
      )}

      <Modal
        visible={showSheet}
        transparent
        animationType="fade"
        // Android's Back, through the same door as the backdrop and the drag,
        // so an unsent draft survives all three rather than two of them.
        onRequestClose={dismiss}
      >
        {/* A `Modal` is its own native window, and gesture-handler only routes
            touches inside a root view. Without this second one the drag on the
            sheet's handle silently never fires — the gesture is registered and
            simply never receives anything. */}
        <GestureHandlerRootView style={styles.fill}>
          {/* Named, because it is the first thing a screen reader lands on
              inside this window and "button" on its own is a dead end. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            style={[styles.backdrop, { backgroundColor: colors.overlay }]}
            onPress={dismiss}
          />
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.sheetWrap}
          >
          <SheetCard
            offset={sheetY}
            style={[
              styles.sheet,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                // Rounded when it floats, square when it is docked to the
                // keyboard. A sheet with a big top radius sitting on a
                // square-cornered keyboard reads as two stacked panels with a
                // sliver of the page showing between them, which is exactly
                // what it is and exactly what it should not look like: while
                // you are typing, the sheet and the keys are one surface.
                borderTopLeftRadius: typing ? 0 : radius.xl,
                borderTopRightRadius: typing ? 0 : radius.xl,
                paddingBottom: insets.bottom + spacing.lg,
                gap: spacing.md,
              },
            ]}
          >
            <GestureDetector gesture={dragToDismiss}>
              {/* Padded well past the bar itself so the target is thumb-sized.
                  A `Pressable` rather than a `View` with `onAccessibilityTap`,
                  which was the whole exit for a screen reader and worked on
                  neither platform: a bare `View` is not an accessibility
                  element at all unless it is told to be, and the tap callback
                  is iOS-only — TalkBack's double tap needs something clickable
                  under it. This is the sheet's own Close, drawn as a grabber:
                  the drag is invisible, and it is the first thing to fail for
                  anyone with a motor impairment. */}
              <Pressable
                testID="voice-sheet-close"
                accessibilityRole="button"
                accessibilityLabel="Close"
                accessibilityHint="Closes the voice sheet. You can also drag it down."
                onPress={dismiss}
                style={styles.grabberHit}
              >
                <View style={[styles.grabber, { backgroundColor: colors.borderStrong }]} />
              </Pressable>
            </GestureDetector>

            {/* Away from home this line is the only report of what the session
                is doing, so Android is told to read it when it changes. On home
                it is `HomeMic` that says so, and a region here would be the
                second voice saying the same thing. */}
            {status === 'listening' ? (
              <Txt variant="heading" tone="accent" accessibilityLiveRegion={onHome ? 'none' : 'polite'}>
                Listening…
              </Txt>
            ) : status === 'sending' ? (
              // Off home this line is the only thing reporting the session, and
              // `sending` can last the 2.5s the recogniser is allowed to take
              // handing over a final result. Without its own branch the heading
              // simply vanished for that whole window, over a transcript still
              // sitting underneath it.
              <Txt variant="heading" tone="accent" accessibilityLiveRegion={onHome ? 'none' : 'polite'}>
                Sending…
              </Txt>
            ) : status === 'thinking' ? (
              <Txt variant="heading" tone="accent" accessibilityLiveRegion={onHome ? 'none' : 'polite'}>
                Working on it…
              </Txt>
            ) : null}

            {partial ? (
              <Txt variant="body" tone="secondary">
                {partial}
              </Txt>
            ) : null}

            {transcript ? (
              // One element, or it reads as "YOU SAID" and then, on a separate
              // swipe, a sentence with nothing saying whose it is.
              <View style={{ gap: 2 }} accessible accessibilityLabel={`You said: ${transcript}`}>
                <Txt variant="micro" tone="tertiary">
                  YOU SAID
                </Txt>
                <Txt variant="body">{transcript}</Txt>
              </View>
            ) : null}

            {/* The message only. The buttons that used to live here were a
                second copy of the action row at the bottom of the sheet — an
                error put "Try again" beside "Speak" and "Type it" beside
                "Type", which read as four choices where there are two. */}
            {errorLine ? (
              /* The region sits on the sentence itself rather than on the
                 wrapper: it is the element whose own words are the news, and a
                 region on both would have Android read the failure twice. The
                 second line is a consequence of the first, not a second
                 announcement, so it carries neither. */
              <View style={{ gap: 2 }}>
                <Txt
                  variant="body"
                  tone="danger"
                  // Assertive: a failure is worth interrupting for, and the
                  // alternative is a red sentence nobody is told about.
                  accessibilityRole="alert"
                  accessibilityLiveRegion="assertive"
                >
                  {errorLine}
                </Txt>
                {heardNothing ? (
                  <Txt variant="caption" tone="secondary">
                    Nothing was saved and nothing was sent. Type it instead if this keeps
                    happening — that path cannot lose it.
                  </Txt>
                ) : null}
              </View>
            ) : null}

            {/* The offer to take back whatever this turn was holding. Above the
                results, because a failed turn has none and this is then the
                only thing in the sheet worth reading. */}
            {recovered && !typing ? <UnsentTranscript /> : null}

            {clarification ? (
              // The most important thing on this sheet, and the one thing that
              // must never be silent: this is both a handler's "is this what
              // you meant?" and the review gate's preview of a write that has
              // not landed yet. Grouped into one element and prefixed, because
              // the question mark is carried by a help glyph the reader cannot
              // see, and answered blind a yes is still a yes.
              <View
                accessible
                accessibilityRole="alert"
                accessibilityLiveRegion="assertive"
                accessibilityLabel={`Ridik asks: ${clarification.question}`}
                style={[
                  styles.clarify,
                  { backgroundColor: colors.accentMuted, borderRadius: radius.md },
                ]}
              >
                <Ionicons name="help-circle-outline" size={18} color={colors.accent} />
                {clarification.preview ? (
                  /*
                   * The review gate's question, laid out instead of flattened.
                   *
                   * It used to be the spoken sentence, printed: "Add to
                   * calendar — Title: Gym, Starts: Tue 10 Mar, 15:00?" — one
                   * run-on line of labels and colons, which is a parameter dump
                   * with a question mark on it. A confirmation is only worth
                   * interrupting for if it is checkable at a glance, and the
                   * first thing that has to be checkable is *what kind of thing
                   * this is*: "Add to calendar" over "Add a task" is the
                   * difference between two entirely different rows, and it was
                   * buried at the head of a sentence nobody reads to the end.
                   *
                   * So the kind is a heading and every value gets its own line.
                   * The sentence still exists and is still what gets spoken and
                   * announced — see `accessibilityLabel` on the wrapper.
                   */
                  <View style={{ flex: 1, gap: 6 }}>
                    <Txt variant="heading" tone="accent">
                      {clarification.preview.title}
                    </Txt>
                    {clarification.preview.lines.map((entry, index) => (
                      <View key={index} style={styles.previewLine}>
                        {entry.label ? (
                          <Txt variant="micro" tone="tertiary" style={styles.previewLabel}>
                            {entry.label}
                          </Txt>
                        ) : (
                          <View style={styles.previewLabel} />
                        )}
                        <Txt variant="body" style={{ flex: 1 }}>
                          {entry.value}
                        </Txt>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Txt variant="body" style={{ flex: 1 }}>
                    {clarification.question}
                  </Txt>
                )}
              </View>
            ) : null}

            {/*
              Two taps, and neither of them reaches the model.

              `classifyConfirmation` in the orchestrator parses these words
              before anything else happens: a yes replays the actions that were
              already parked, and a no drops them. So the whole exchange is free
              — which is why forcing it through a keyboard was the wrong shape
              twice over. It was slow, and it was slow in an app whose premise is
              that you do not have to look at it.

              "No" does not end the turn. It opens the box with the question
              still on screen, because the useful answer to "Book it Thursday at
              14:00?" is usually not "no" but "no — Friday".
            */}
            {yesNo && !correcting ? (
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Button
                  label="Yes"
                  variant="primary"
                  icon="checkmark"
                  disabled={status === 'thinking'}
                  accessibilityLabel={`Yes — ${clarification.question}`}
                  onPress={() => void submitText('yes')}
                />
                <Button
                  label="No"
                  icon="close"
                  disabled={status === 'thinking'}
                  accessibilityLabel={`No — ${clarification.question}`}
                  onPress={() => {
                    setCorrecting(true);
                    setTyping(true);
                  }}
                />
              </View>
            ) : null}

            {outcome?.notice ? (
              <View
                style={[
                  styles.clarify,
                  { backgroundColor: colors.warningMuted, borderRadius: radius.md },
                ]}
              >
                <Ionicons name="wallet-outline" size={18} color={colors.warning} />
                {/* Not `accessible` on the wrapper: it holds a button, and
                    grouping would swallow the one thing that fixes what the
                    notice describes. The sentence carries the region instead. */}
                <View style={{ flex: 1, gap: spacing.sm, alignItems: 'flex-start' }}>
                  <Txt
                    variant="caption"
                    tone="warning"
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                  >
                    {outcome.notice}
                  </Txt>
                  {/* The paywall was reachable from exactly one row in
                      Settings. Being told the assistant is off and left to go
                      looking for the way back on is the same as not being told. */}
                  {outcome.noticeAction ? (
                    <Button
                      label={outcome.noticeAction.label}
                      size="sm"
                      icon="sparkles-outline"
                      onPress={() => {
                        const href = outcome.noticeAction?.href;
                        if (!href) return;
                        dismiss();
                        router.push(href as never);
                      }}
                    />
                  ) : null}
                </View>
              </View>
            ) : null}

            {outcome && outcome.items.length > 0 ? (
              <ScrollView style={{ maxHeight: 260 }} keyboardShouldPersistTaps="handled">
                {/* The list is the receipt on every screen but home, where the
                    card under the mic already carries one — and two live
                    regions for one turn is the same result read twice. */}
                <View
                  style={{ gap: spacing.sm }}
                  accessibilityLiveRegion={onHome ? 'none' : 'polite'}
                >
                  {outcome.items.map((item, i) => (
                    <View key={`${item.toolName}-${i}`} style={{ gap: spacing.sm }}>
                      <ResultRow
                        item={item}
                        onPress={() => {
                          if (!item.href) return;
                          close();
                          router.push(item.href as never);
                        }}
                      />
                      {/* What a question was actually asking for. Beside the
                          result rather than inside it: `ResultRow` is a
                          Pressable, and a link nested in a link is a tap the
                          platform gets to arbitrate. */}
                      {item.results && item.results.length > 0 ? (
                        <View
                          style={[
                            styles.hits,
                            { borderColor: colors.border, marginLeft: spacing.md },
                          ]}
                        >
                          {item.results.map((hit, h) => (
                            <HitRow
                              key={`${hit.label}-${h}`}
                              hit={hit}
                              onPress={() => {
                                if (!hit.href) return;
                                close();
                                router.push(hit.href as never);
                              }}
                            />
                          ))}
                        </View>
                      ) : null}
                    </View>
                  ))}
                </View>
              </ScrollView>
            ) : null}

            {outcome?.feedback && !clarification ? (
              <Txt variant="caption" tone="secondary">
                {outcome.feedback}
              </Txt>
            ) : null}

            {/*
              A pending question used to render this box unconditionally, which
              is why turning off the forced `setTyping` was not enough on its
              own: a yes/no question still came up with a focused text field and
              a keyboard over half the sheet, under two buttons that made it
              pointless. The box belongs to typing, to an *open* question, and
              to a No that is being corrected — not to the existence of a
              question.
            */}
            {typing || correcting || (clarification && !yesNo) ? (
              <View style={{ gap: spacing.sm }}>
                {reviewing && !clarification ? (
                  /*
                    The one line that turns a text box into a check.

                    Without it this surface is indistinguishable from the one
                    that comes up when dictation *failed*, and a person whose
                    sentence was heard perfectly is looking at what reads like an
                    error. It says what was heard and what has not happened yet;
                    the second half is the part that makes waiting here feel like
                    a choice rather than a hang.

                    A live region, because it appears with news on it and the
                    box below it steals the focus — see `src/ui/a11y.ts`.
                  */
                  <Txt
                    variant="caption"
                    tone="secondary"
                    accessibilityLiveRegion="polite"
                    testID="voice-review-note"
                  >
                    {REVIEW_NOTE}
                  </Txt>
                ) : null}
                <Input
                  autoFocus={!reviewing}
                  value={draft}
                  onChangeText={setDraft}
                  // The placeholder is a hint on one platform and the label on
                  // the other; saying it outright is the only way both hear the
                  // same thing — and the answer box has to say what it is
                  // answering.
                  accessibilityLabel={
                    clarification
                      ? `Your answer to: ${clarification.question}`
                      : reviewing
                        ? `What Ridik heard, ready to edit: ${draft}`
                        : 'What you would have said'
                  }
                  /*
                    The placeholder is the only place the *length* of a useful
                    answer can be taught, and it is worth teaching: this box is
                    reached by tapping No on a concrete proposal, so what is
                    wanted is the correction, not the whole sentence again.
                    "Your answer…" invited a paragraph.
                  */
                  placeholder={
                    correcting
                      ? 'What instead? e.g. Friday at 3'
                      : clarification
                        ? 'Your answer…'
                        : reviewing
                          ? 'What Ridik heard…'
                          : 'Type what you would have said…'
                  }
                  multiline
                  /*
                    A multiline box with no ceiling grows with its content, and
                    this one is seeded by dictation — so a long spoken paragraph
                    pushed the Send button, the line explaining what the box is,
                    and the sheet's own grab handle off the top of the screen,
                    leaving no visible way to send it or to get out. The words
                    scroll inside the cap instead.

                    `maxLength` below is the other half and a different concern:
                    that one is about what reaches the prompt builder, this one
                    is about what reaches the screen.
                  */
                  style={{ maxHeight: COMPOSER_MAX_HEIGHT }}
                  // This box is "what you would have said", and nobody says
                  // twenty thousand characters. It took a paste of any size:
                  // a megabyte of text is a quarter of a million tokens
                  // billed against the key in one turn. The budget's own
                  // per-turn ceiling is what actually refuses that; this stops
                  // it reaching React state and the prompt builder at all.
                  maxLength={MAX_DRAFT_CHARS}
                  returnKeyType="send"
                  onSubmitEditing={send}
                  testID="voice-text-input"
                />
                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <Button
                    label="Send"
                    variant="primary"
                    icon="arrow-up"
                    onPress={send}
                    // A turn is already in flight and a second one is refused,
                    // so the button says so rather than looking live and
                    // swallowing the sentence.
                    disabled={!draft.trim() || status === 'thinking'}
                  />
                  <Button
                    // "Speak instead" is right when the box replaced the
                    // microphone. Here the microphone is what filled it, so the
                    // offer is to have another go at the same sentence.
                    label={reviewing ? 'Say it again' : 'Speak instead'}
                    icon="mic"
                    onPress={() => {
                      setTyping(false);
                      setReviewing(false);
                      void startListening();
                    }}
                  />
                  {reviewing ? (
                    // The third answer, and the only one that costs nothing.
                    // Without it the way out of a wrong transcript is to clear
                    // the box by hand or dismiss the sheet, and dismissing it
                    // files the words as unsent — a card on home about a
                    // sentence the user had already decided against.
                    <Button
                      label="Discard"
                      variant="ghost"
                      onPress={() => {
                        setDraft('');
                        setReviewing(false);
                        setTyping(false);
                        close();
                      }}
                    />
                  ) : null}
                </View>
              </View>
            ) : (
              // Two choices, and the first one changes its name to match what
              // pressing it will do. No Close: the sheet is dragged away by its
              // handle, tapped away on the backdrop, or dismissed with Back.
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Button
                  label={listening ? 'Stop' : error ? 'Try again' : 'Speak'}
                  variant="primary"
                  icon={listening ? 'stop' : 'mic'}
                  onPress={onPressMic}
                />
                <Button label="Type" icon="create-outline" onPress={() => setTyping(true)} />
              </View>
            )}
            </SheetCard>
          </KeyboardAvoidingView>
        </GestureHandlerRootView>
      </Modal>
    </>
  );
}

/**
 * One line of the receipt, extracted because each needs its own animation state
 * and a hook cannot be called from inside a `map`.
 *
 * Half of these rows go nowhere — `href` is what makes one a link — so the
 * press is disabled with it rather than left to answer a tap that does nothing.
 * Inside a `Modal`, so the press is an effect-driven shared value.
 */
function ResultRow({ item, onPress }: { item: VoiceOutcomeItem; onPress: () => void }) {
  const { colors, radius } = useTheme();
  const press = usePressScale({ scale: 0.98, disabled: !item.href });
  return (
    <AnimatedPressable
      // Whether this one landed is a tick or a triangle in one of two colours,
      // and nothing else — so a screen reader read a list in which every line,
      // including the ones that failed, sounded like a success.
      accessibilityRole={item.href ? 'button' : 'text'}
      accessibilityLabel={`${item.ok ? 'Done' : 'Not done'}. ${item.summary}${
        item.detail ? `. ${item.detail}` : ''
      }`}
      {...(item.href ? { accessibilityHint: 'Opens it' } : {})}
      accessibilityState={{ disabled: !item.href }}
      disabled={!item.href}
      onPress={onPress}
      {...press.handlers}
      style={[styles.result, { borderColor: colors.border, borderRadius: radius.sm }, press.style]}
    >
      <Ionicons
        name={item.ok ? 'checkmark-circle' : 'alert-circle'}
        size={17}
        color={item.ok ? colors.success : colors.warning}
      />
      <View style={{ flex: 1, gap: 1 }}>
        <Txt variant="caption" weight="600">
          {item.summary}
        </Txt>
        {item.detail ? (
          <Txt variant="micro" tone="tertiary">
            {item.detail}
          </Txt>
        ) : null}
      </View>
      {item.href ? <Ionicons name="chevron-forward" size={14} color={colors.textTertiary} /> : null}
    </AnimatedPressable>
  );
}

/**
 * One thing a search found.
 *
 * Its own row because the answer to a question is a list you can open, not a
 * sentence counting the list. Quieter than a `ResultRow` on purpose: the
 * result of the turn is "I found six things", and these are the six.
 */
function HitRow({ hit, onPress }: { hit: NonNullable<VoiceOutcomeItem['results']>[number]; onPress: () => void }) {
  const { colors } = useTheme();
  const press = usePressScale({ scale: 0.98, disabled: !hit.href });
  return (
    <AnimatedPressable
      disabled={!hit.href}
      accessibilityRole={hit.href ? 'link' : 'text'}
      accessibilityLabel={hit.scope ? `${hit.label}, ${hit.scope}` : hit.label}
      onPress={onPress}
      {...press.handlers}
      style={[styles.hit, press.style]}
    >
      {/* `flex: 1` rather than shrink-to-fit: Android measures a `Text` in a
          flex row short and clips it instead of wrapping. */}
      <Txt variant="caption" numberOfLines={1} style={{ flex: 1 }}>
        {hit.label}
      </Txt>
      {hit.scope ? (
        // 2pt of slack, the same reason `Button`'s label carries it: Bricolage's
        // ink reaches past its advance width and Android clips to the advance.
        <Txt variant="micro" tone="tertiary" style={{ paddingRight: 2 }}>
          {hit.scope}
        </Txt>
      ) : null}
      {hit.href ? <Ionicons name="chevron-forward" size={12} color={colors.textTertiary} /> : null}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  dock: {
    position: 'absolute',
    right: MIC_DOCK_RIGHT,
    alignItems: 'flex-end',
    gap: 8,
    zIndex: 50,
  },
  mic: {
    width: MIC_SIZE,
    height: MIC_SIZE,
    borderRadius: MIC_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  partial: {
    maxWidth: 260,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  fill: { flex: 1 },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: { paddingHorizontal: 18, paddingTop: 10, borderWidth: StyleSheet.hairlineWidth },
  grabberHit: { alignSelf: 'stretch', alignItems: 'center', paddingTop: 4, paddingBottom: 12 },
  grabber: { width: 40, height: 4, borderRadius: 2 },
  clarify: { flexDirection: 'row', gap: 8, padding: 12, alignItems: 'flex-start' },
  previewLine: { flexDirection: 'row', gap: 8, alignItems: 'baseline' },
  // A reserved column, so the values line up whether or not a row has a label —
  // the same rule `ReserveRowLead` follows for settings rows. 62 fits "Repeats",
  // the longest label `describeAction` produces.
  previewLabel: { width: 62 },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    padding: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  // A rule down the left rather than a card each: these belong to the row
  // above them, and six bordered boxes read as six separate results.
  hits: { borderLeftWidth: StyleSheet.hairlineWidth, paddingLeft: 10 },
  hit: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
});
