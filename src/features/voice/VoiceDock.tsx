import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
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
import { MIC_GAP, MIC_SIZE } from '@/ui/layout';
import { useVoiceStore } from './store';
import { useQuickActionRouting } from './useQuickActions';

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
  const outcome = useVoiceStore((s) => s.outcome);
  const clarification = useVoiceStore((s) => s.pendingClarification);
  const startListening = useVoiceStore((s) => s.startListening);
  const stopListening = useVoiceStore((s) => s.stopListening);
  const submitText = useVoiceStore((s) => s.submitText);
  const close = useVoiceStore((s) => s.close);
  const open = useVoiceStore((s) => s.open);

  const [draft, setDraft] = useState('');
  const [typing, setTyping] = useState(false);

  const pulse = useSharedValue(1);
  const listening = status === 'listening';

  useEffect(() => {
    if (listening) {
      pulse.value = withRepeat(
        withSequence(
          withTiming(1.14, { duration: 620, easing: Easing.out(Easing.quad) }),
          withTiming(1, { duration: 620, easing: Easing.in(Easing.quad) }),
        ),
        -1,
        false,
      );
    } else {
      cancelAnimation(pulse);
      pulse.value = withTiming(1, { duration: 180 });
    }
  }, [listening, pulse]);

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

  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));

  /**
   * On home the screen is already the voice interface — the field floods, the
   * ring pulses, the caption says what is happening, and the receipt shows the
   * result. Sliding a sheet and a scrim over all of that hides the one thing
   * the app is for. So here the sheet is reserved for the cases that genuinely
   * need it: a question to answer, a failure to retry, or typing.
   *
   * Everywhere else it opens as it always did; those screens have no other way
   * to show what happened.
   */
  const needsSheet = Boolean(clarification) || Boolean(error) || typing;
  const showSheet = expanded && (!onHome || needsSheet);

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
            <Pressable
              testID="voice-mic"
              accessibilityRole="button"
              accessibilityLabel={listening ? 'Stop listening' : 'Start voice capture'}
              accessibilityHint="Long press to type instead"
              onPress={onPressMic}
              onLongPress={onLongPressMic}
              style={({ pressed }) => [
                styles.mic,
                {
                  backgroundColor: micColor,
                  shadowColor: micColor,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Ionicons name={micIcon} size={26} color={colors.surface} />
            </Pressable>
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
        animationType="slide"
        onRequestClose={() => {
          setTyping(false);
          close();
        }}
      >
        <Pressable
          style={[styles.backdrop, { backgroundColor: colors.overlay }]}
          onPress={() => {
            setTyping(false);
            close();
          }}
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.sheetWrap}
        >
          <View
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
            <View style={styles.grabber} />

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

            {error ? (
              <View style={{ gap: spacing.sm }}>
                <Txt variant="body" tone="danger">
                  {needsRetry ? "I didn't catch that clearly. Try again?" : error}
                </Txt>
                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <Button label="Try again" icon="mic" onPress={() => void startListening()} />
                  <Button label="Type it" icon="create-outline" onPress={() => setTyping(true)} />
                </View>
              </View>
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
                <Txt variant="caption" tone="warning" style={{ flex: 1 }}>
                  {outcome.notice}
                </Txt>
              </View>
            ) : null}

            {outcome && outcome.items.length > 0 ? (
              <ScrollView style={{ maxHeight: 260 }} keyboardShouldPersistTaps="handled">
                <View style={{ gap: spacing.sm }}>
                  {outcome.items.map((item, i) => (
                    <Pressable
                      key={`${item.toolName}-${i}`}
                      disabled={!item.href}
                      onPress={() => {
                        if (!item.href) return;
                        close();
                        router.push(item.href as never);
                      }}
                      style={[
                        styles.result,
                        { borderColor: colors.border, borderRadius: radius.sm },
                      ]}
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
                      {item.href ? (
                        <Ionicons name="chevron-forward" size={14} color={colors.textTertiary} />
                      ) : null}
                    </Pressable>
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
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Button
                  label={listening ? 'Stop' : 'Speak'}
                  variant="primary"
                  icon={listening ? 'stop' : 'mic'}
                  onPress={onPressMic}
                />
                <Button label="Type" icon="create-outline" onPress={() => setTyping(true)} />
                <Button label="Close" variant="ghost" onPress={() => { setTyping(false); close(); }} />
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
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
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  partial: {
    maxWidth: 260,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: { paddingHorizontal: 18, paddingTop: 10, borderWidth: StyleSheet.hairlineWidth },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(128,128,140,0.5)',
    marginBottom: 4,
  },
  clarify: { flexDirection: 'row', gap: 8, padding: 12, alignItems: 'flex-start' },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    padding: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
