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
import { Txt } from '@/ui/components/Text';
import { Button } from '@/ui/components/Button';
import { Input } from '@/ui/components/Controls';
import { SheetCard } from '@/ui/components/SheetCard';
import { MIC_GAP, MIC_SIZE } from '@/ui/layout';
import { SPRING_TAP } from '@/ui/motion';
import { AnimatedPressable, usePressScale, usePulse } from '@/ui/motionHooks';
import { elevate } from '@/ui/shadow';
import { useVoiceStore, type VoiceOutcomeItem } from './store';
import { useQuickActionRouting } from './useQuickActions';

/**
 * The longest thing the typed box will accept — about 5,000 words, which is
 * far more than anyone dictates and still a bounded number of tokens.
 */
const MAX_DRAFT_CHARS = 20_000;

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
  const outcome = useVoiceStore((s) => s.outcome);
  const clarification = useVoiceStore((s) => s.pendingClarification);
  const startListening = useVoiceStore((s) => s.startListening);
  const stopListening = useVoiceStore((s) => s.stopListening);
  const submitText = useVoiceStore((s) => s.submitText);
  const close = useVoiceStore((s) => s.close);
  const open = useVoiceStore((s) => s.open);

  const [draft, setDraft] = useState('');
  const [typing, setTyping] = useState(false);

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
   */
  const needsSheet =
    Boolean(clarification) || Boolean(error) || typing || Boolean(outcome?.notice);
  const showSheet = expanded && (!onHome || needsSheet);

  const dismiss = useCallback(() => {
    setTyping(false);
    close();
  }, [close]);

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
    setTyping(true);
    open();
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
          <Animated.View style={pulseStyle}>
            <AnimatedPressable
              testID="voice-mic"
              accessibilityRole="button"
              accessibilityLabel={listening ? 'Stop listening' : 'Start voice capture'}
              accessibilityHint="Long press to type instead"
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
        onRequestClose={() => {
          setTyping(false);
          close();
        }}
      >
        {/* A `Modal` is its own native window, and gesture-handler only routes
            touches inside a root view. Without this second one the drag on the
            sheet's handle silently never fires — the gesture is registered and
            simply never receives anything. */}
        <GestureHandlerRootView style={styles.fill}>
          <Pressable
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
              {/* Padded well past the bar itself so the target is thumb-sized. */}
              <View
                accessibilityRole="button"
                accessibilityLabel="Close"
                accessibilityHint="Drag down to dismiss"
                onAccessibilityTap={dismiss}
                style={styles.grabberHit}
              >
                <View style={[styles.grabber, { backgroundColor: colors.borderStrong }]} />
              </View>
            </GestureDetector>

            {status === 'listening' ? (
              <Txt variant="heading" tone="accent">
                Listening…
              </Txt>
            ) : status === 'thinking' ? (
              <Txt variant="heading" tone="accent">
                Working on it…
              </Txt>
            ) : null}

            {partial ? (
              <Txt variant="body" tone="secondary">
                {partial}
              </Txt>
            ) : null}

            {transcript ? (
              <View style={{ gap: 2 }}>
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
            {error ? (
              <Txt variant="body" tone="danger">
                {needsRetry ? "I didn't catch that clearly. Try again?" : error}
              </Txt>
            ) : null}

            {clarification ? (
              <View
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
                <View style={{ flex: 1, gap: spacing.sm, alignItems: 'flex-start' }}>
                  <Txt variant="caption" tone="warning">
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
                <View style={{ gap: spacing.sm }}>
                  {outcome.items.map((item, i) => (
                    <ResultRow
                      key={`${item.toolName}-${i}`}
                      item={item}
                      onPress={() => {
                        if (!item.href) return;
                        close();
                        router.push(item.href as never);
                      }}
                    />
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
});
