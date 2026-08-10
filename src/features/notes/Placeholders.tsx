import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Button, Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';

/**
 * A failed read is a row in the list, never a screen. The rest of the cache is
 * still good and the mic still works, so taking the whole surface away would
 * cost the user more than the missing rows.
 */
export function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      // A View is not `accessible` by default, so the role alone announces nothing.
      accessible
      accessibilityRole="alert"
      style={[
        styles.error,
        {
          backgroundColor: colors.dangerMuted,
          borderRadius: radius.sm,
          paddingHorizontal: spacing.md,
          gap: spacing.sm,
        },
      ]}
    >
      <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
      <Txt variant="caption" tone="danger" style={{ flex: 1 }}>
        {message}
      </Txt>
      <Button label="Retry" size="sm" variant="ghost" onPress={onRetry} />
    </View>
  );
}

/**
 * Placeholder rows shaped like the real ones. Only ever shown on a cold cache —
 * a refetch over cached data keeps the old rows and moves the inline spinner.
 */
export function SkeletonRows({ count = 5, height = 54 }: { count?: number; height?: number }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View accessibilityLabel="Loading" style={{ gap: spacing.sm, paddingVertical: spacing.sm }}>
      {Array.from({ length: count }, (_, index) => (
        <View
          key={index}
          style={{
            height,
            borderRadius: radius.sm,
            backgroundColor: colors.surfaceRaised,
            // Fading down the stack reads as "more is coming" rather than as
            // rows that failed to paint.
            opacity: 1 - index * 0.14,
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  error: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
});
