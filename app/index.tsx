/**
 * Home: a microphone, lit from behind by the thing it does.
 *
 * The whole app used to be five tabs and a floating button. It is one screen
 * now — you talk, and you see what that did. Everything else is behind the menu
 * in the corner, which is where those screens belong: you go to them to check
 * or correct something, not to start.
 *
 * The layout is fixed, not scrolling, and deliberately so. The mic sits in the
 * same place every time the app opens, and nothing above or below it can push
 * it out from under your thumb.
 */
import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { HomeMic, LastAction, NextUpLine, nextUp, useDailyBriefing } from '@/features/home';
// Imported from the modules rather than `@/features/today`: that barrel pulls
// in every section of the old Today screen, and with them the briefing's
// text-to-speech and the focus runtime. Home needs three pure things from it,
// and should not be loading a speech stack to draw a clock.
import { buildAgenda } from '@/features/today/agenda';
import { SectionBoundary } from '@/features/today/Fallbacks';
import { useNow } from '@/features/today/useNow';
import { useVoiceStore } from '@/features/voice/store';
import { useToday } from '@/hooks';
import { HeatField, type HeatState } from '@/ui/HeatField';
import { useTheme } from '@/ui/ThemeProvider';
import { STAGGER_MS, tap } from '@/ui/motion';
import { useNavigateOnce } from '@/ui/useNavigateOnce';

/** The field answers to the voice session; speaking and thinking look alike. */
const FIELD_STATE: Record<string, HeatState> = {
  idle: 'idle',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'thinking',
  error: 'error',
};

export default function HomeScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigateOnce();
  const today = useToday();
  const at = useNow();
  const reduced = useReducedMotion();
  const status = useVoiceStore((s) => s.status);



  const snapshot = today.data;

  // Shown once a day, on the first open — it replaced the scheduled
  // notification. Held until the day has loaded: expo-router silently drops a
  // push made before the navigator mounts.
  useDailyBriefing(snapshot != null);

  const next = useMemo(() => {
    if (!snapshot) return null;
    const agenda = buildAgenda({
      events: snapshot.events,
      classes: snapshot.classes,
      window: { start: snapshot.dayStart, end: snapshot.dayEnd },
      now: at,
    });
    return nextUp(agenda, at);
  }, [snapshot, at]);

  // One arrival, ordered the way the eye should travel: corners, then what is
  // next, then the mic. Skipped entirely under reduced motion — a shorter
  // animation is not the accommodation, no animation is.
  const arrive = (index: number) =>
    reduced ? undefined : FadeIn.duration(320).delay(index * STAGGER_MS);

  return (
    <View style={styles.root}>
      <HeatField state={FIELD_STATE[status] ?? 'idle'} />

      <View
        style={{
          flex: 1,
          paddingTop: insets.top,
          paddingBottom: insets.bottom + spacing.lg,
          paddingHorizontal: spacing.lg,
        }}
      >
        <Animated.View entering={arrive(0)} style={styles.corners}>
          <CornerButton icon="menu" label="Menu" testID="home-menu" onPress={() => nav.push('/menu')} />
          <CornerButton
            icon="person"
            label="Profile and settings"
            testID="home-profile"
            onPress={() => nav.push('/settings')}
          />
        </Animated.View>

        {/* Only rendered once the day has loaded: a "Nothing left today" that
            turns into a 15:00 meeting a moment later is worse than a blank. */}
        <View style={{ paddingTop: spacing.xl, minHeight: 132 }}>
          {snapshot ? (
            <Animated.View entering={arrive(1)}>
              <SectionBoundary label="next up">
                <NextUpLine next={next} zone={snapshot.zone} />
              </SectionBoundary>
            </Animated.View>
          ) : null}
        </View>

        <Animated.View entering={arrive(2)} style={styles.stage}>
          <HomeMic />
        </Animated.View>

        <SectionBoundary label="last action">
          <LastAction />
        </SectionBoundary>
      </View>
    </View>
  );
}

/**
 * The two ways off this screen, as the darkest objects on it after the mic.
 *
 * Filled discs rather than bare glyphs: on a field this saturated an unfilled
 * icon has no ground of its own and its contrast drifts with whatever the
 * gradient is doing underneath it.
 */
function CornerButton({
  icon,
  label,
  testID,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  testID: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const press = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: 1 - press.value * 0.1 }] }));

  return (
    <Animated.View style={style}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        onPressIn={() => {
          press.value = tap(1);
        }}
        onPressOut={() => {
          press.value = tap(0);
        }}
        onPress={onPress}
        hitSlop={10}
        style={[styles.corner, { backgroundColor: colors.text }]}
      >
        <Ionicons name={icon} size={19} color={colors.surface} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  corners: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  corner: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
