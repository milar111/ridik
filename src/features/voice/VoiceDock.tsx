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
import { MIC_GAP, MIC_SIZE } from '@/ui/layout';
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
  const keepDraft = useVoiceStore((s) => s.keepDraft);
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

  const listening = status === 'listening';

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

  useEffect(() => {
    if (clarification) setTyping(true);
  }, [clarification]);

  // Nothing to retry on a device with no recogniser, so go straight to the way
  // that does work rather than showing a "Try again" that never will.
  useEffect(() => {
    if (sttUnavailable) setTyping(true);
  }, [sttUnavailable]);

  /**
   * A recovered transcript arriving from anywhere — the card in this sheet, or
   * the one on home, which is a different component entirely and cannot reach
   * this text box. The store carries the text between them; the dock takes it.
   */
  useEffect(() => {
    if (draftSeed == null) return;
    setDraft(draftSeed);
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
   */
  const dismiss = useCallback(() => {
    if (draft.trim()) keepDraft(draft);
    setDraft('');
    // `close()` owns `typing` now that it lives in the store, so there is one
    // place deciding what a dismissed sheet leaves behind. The *text* is still
    // local to this component, which is why it is stashed here first.
    close();
  }, [close, draft, keepDraft]);

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
  const micIcon: keyof typeof Ionicons.glyphMap =
    status === 'thinking' ? 'ellipsis-horizontal' : status === 'speaking' ? 'volume-high' : 'mic';

  const onPressMic = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    if (listening) void stopListening();
    else void startListening();
  };

  const onLongPressMic = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    startTyping();
  };

  const send = () => {
    const text = draft;
    setDraft('');
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
              <Ionicons name={micIcon} size={26} color={colors.surface} />
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
                borderTopLeftRadius: radius.xl,
                borderTopRightRadius: radius.xl,
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
                <Txt variant="body" style={{ flex: 1 }}>
                  {clarification.question}
                </Txt>
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

            {typing || clarification ? (
              <View style={{ gap: spacing.sm }}>
                <Input
                  autoFocus
                  value={draft}
                  onChangeText={setDraft}
                  // The placeholder is a hint on one platform and the label on
                  // the other; saying it outright is the only way both hear the
                  // same thing — and the answer box has to say what it is
                  // answering.
                  accessibilityLabel={
                    clarification ? `Your answer to: ${clarification.question}` : 'What you would have said'
                  }
                  placeholder={clarification ? 'Your answer…' : 'Type what you would have said…'}
                  multiline
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
                  <Button label="Send" variant="primary" icon="arrow-up" onPress={send} disabled={!draft.trim()} />
                  <Button label="Speak instead" icon="mic" onPress={() => { setTyping(false); void startListening(); }} />
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
  dock: { position: 'absolute', right: 18, alignItems: 'flex-end', gap: 8, zIndex: 50 },
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
