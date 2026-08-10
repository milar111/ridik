/**
 * Home: the mic, and only what earns its place beside it.
 *
 * The whole app used to be five tabs and a floating button. It is one screen
 * now — you talk, and you see what that did. Everything else is behind the menu
 * in the corner, which is the right place for it: those screens are where you
 * go to check or correct something, not where the work starts.
 *
 * The layout is fixed, not scrolling, and deliberately so. The mic sits in the
 * same spot every time you open the app, and nothing above or below it can push
 * it out from under your thumb.
 */
import { useMemo } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { HomeMic, LastAction, NextUpLine, nextUp } from '@/features/home';
// Imported from the modules rather than `@/features/today`: that barrel pulls
// in every section of the old Today screen, and with them the briefing's
// text-to-speech and the focus runtime. Home needs three pure things from it,
// and should not be loading a speech stack to draw a clock.
import { buildAgenda } from '@/features/today/agenda';
import { SectionBoundary } from '@/features/today/Fallbacks';
import { useNow } from '@/features/today/useNow';
import { useToday } from '@/hooks';
import { useTheme } from '@/ui/ThemeProvider';

export default function HomeScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const today = useToday();
  const at = useNow();

  const snapshot = today.data;

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

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.bg,
        paddingTop: insets.top,
        paddingBottom: insets.bottom + spacing.lg,
        paddingHorizontal: spacing.lg,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <CornerButton
          icon="menu"
          label="Menu"
          testID="home-menu"
          onPress={() => router.push('/menu')}
        />
        <CornerButton
          icon="person-circle-outline"
          label="Profile and settings"
          testID="home-profile"
          onPress={() => router.push('/settings')}
        />
      </View>

      {/* Only rendered once the day has loaded: a "Nothing left today" that
          turns into a 14:00 meeting a moment later is worse than a blank. */}
      <View style={{ paddingTop: spacing.lg, minHeight: 74 }}>
        {snapshot ? (
          <SectionBoundary label="next up">
            <NextUpLine next={next} zone={snapshot.zone} />
          </SectionBoundary>
        ) : null}
      </View>

      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <HomeMic />
      </View>

      <SectionBoundary label="last action">
        <LastAction />
      </SectionBoundary>
    </View>
  );
}

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
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      // Bigger than it looks: the visible glyph is 26pt, the tap target is 44.
      hitSlop={12}
      style={({ pressed }) => [{ padding: 4, opacity: pressed ? 0.6 : 1 }]}
    >
      <Ionicons name={icon} size={26} color={colors.textSecondary} />
    </Pressable>
  );
}
