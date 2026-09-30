import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';

/**
 * The one thing worth interrupting the calendar for: events being written that
 * nothing will ever pick up. Warning, not danger — the events are safe, they
 * are just staying here.
 */
export function SyncBanner({ onPress }: { onPress: () => void }) {
  const { colors, radius, spacing } = useTheme();
  // A banner is nearly the full width of the screen, so it takes the shallow
  // travel a large surface takes; the same 0.96 that reads as contact on a chip
  // would read as the page flinching here.
  const press = usePressScale({ scale: 0.98 });
  return (
    <AnimatedPressable
      testID="calendar-not-connected"
      accessibilityRole="button"
      accessibilityLabel="Google Calendar is not connected. Events show in your phone's own calendar but never reach Google. Open settings to connect."
      onPress={onPress}
      {...press.handlers}
      style={[
        styles.banner,
        {
          backgroundColor: colors.warningMuted,
          borderRadius: radius.sm,
          marginHorizontal: spacing.lg,
        },
        press.style,
      ]}
    >
      <Ionicons name="cloud-offline-outline" size={15} color={colors.warning} />
      <View style={{ flex: 1 }}>
        <Txt variant="caption" style={{ color: colors.warning }}>
          Google Calendar isn’t connected
        </Txt>
        {/*
          Precise on purpose. Events stay on this device — in the phone's *own*
          calendar, which on an Android with a Google account signed in is
          displayed by Samsung Calendar and Google Calendar alike, so they can
          appear in an app that syncs to Google without having reached Google.
          The mirror is a LOCAL calendar (`nativeCalendar.ts`) and Android never
          syncs one of those to an account. Naming the two places is what makes
          the banner worth reading.
        */}
        <Txt variant="micro" tone="tertiary">
          They show in your phone’s calendar, but never reach Google.
        </Txt>
      </View>
      <Ionicons name="chevron-forward" size={14} color={colors.warning} />
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    minHeight: 44,
  },
});
