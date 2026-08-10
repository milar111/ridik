/**
 * The mic, as the whole point of the screen rather than a button floating over
 * one.
 *
 * Same store and the same gestures as the floating dock — tap to talk, tap
 * again to send early, long-press to type — so there is one voice session in
 * the app, not two that can disagree about whether it is listening.
 */
import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { useTheme } from '@/ui/ThemeProvider';
import { Txt } from '@/ui/components/Text';
import { useVoiceStore } from '@/features/voice/store';

const DIAMETER = 132;

/** What the button is doing, in the fewest words that are still true. */
const CAPTION: Record<string, string> = {
  listening: 'Listening — tap to send',
  thinking: 'Working on it',
  speaking: 'Speaking',
  error: 'Tap to try again',
};

export function HomeMic() {
  const { colors, spacing } = useTheme();

  const status = useVoiceStore((s) => s.status);
  const partial = useVoiceStore((s) => s.partial);
  const startListening = useVoiceStore((s) => s.startListening);
  const stopListening = useVoiceStore((s) => s.stopListening);
  const open = useVoiceStore((s) => s.open);

  const listening = status === 'listening';
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (listening) {
      pulse.value = withRepeat(
        withSequence(
          withTiming(1.08, { duration: 620, easing: Easing.out(Easing.quad) }),
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

  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));

  const tint = status === 'error' ? colors.danger : listening ? colors.danger : colors.accent;
  const icon: keyof typeof Ionicons.glyphMap =
    status === 'thinking' ? 'ellipsis-horizontal' : status === 'speaking' ? 'volume-high' : 'mic';

  return (
    <View style={[styles.wrap, { gap: spacing.md }]}>
      <Animated.View style={pulseStyle}>
        <Pressable
          testID="home-mic"
          accessibilityRole="button"
          accessibilityLabel={listening ? 'Stop listening' : 'Start voice capture'}
          accessibilityHint="Long press to type instead"
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
            if (listening) void stopListening();
            else void startListening();
          }}
          onLongPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
            open();
          }}
          style={({ pressed }) => [
            styles.mic,
            { backgroundColor: tint, shadowColor: tint, opacity: pressed ? 0.85 : 1 },
          ]}
        >
          <Ionicons name={icon} size={52} color="#FFFFFF" />
        </Pressable>
      </Animated.View>

      {/* One line, and it never grows into a transcript: the sheet is where a
          conversation happens. A home screen that reflowed while you spoke
          would move the button out from under your thumb. */}
      <Txt variant="caption" tone="secondary" numberOfLines={1} style={styles.caption}>
        {listening && partial ? partial : (CAPTION[status] ?? 'Tap to speak')}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  mic: {
    width: DIAMETER,
    height: DIAMETER,
    borderRadius: DIAMETER / 2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.35,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  caption: { textAlign: 'center', minHeight: 18 },
});
