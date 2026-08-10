import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';

/**
 * The one thing worth interrupting the calendar for: events being written that
 * nothing will ever pick up. Warning, not danger — the events are safe, they
 * are just staying here.
 */
export function SyncBanner({ onPress }: { onPress: () => void }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <Pressable
      testID="calendar-not-connected"
      accessibilityRole="button"
      accessibilityLabel="Google Calendar is not connected. Open settings to connect."
      onPress={onPress}
      style={({ pressed }) => [
        styles.banner,
        {
          backgroundColor: colors.warningMuted,
          borderRadius: radius.sm,
          marginHorizontal: spacing.lg,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Ionicons name="cloud-offline-outline" size={15} color={colors.warning} />
      <View style={{ flex: 1 }}>
        <Txt variant="caption" style={{ color: colors.warning }}>
          Google Calendar isn’t connected
        </Txt>
        <Txt variant="micro" tone="tertiary">
          Events stay on this device until you connect it.
        </Txt>
      </View>
      <Ionicons name="chevron-forward" size={14} color={colors.warning} />
    </Pressable>
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
