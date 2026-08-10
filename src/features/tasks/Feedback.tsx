import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { toAppError } from '@/core/result';
import { Button } from '@/ui/components/Button';
import { Txt } from '@/ui/components/Text';
import { useTheme } from '@/ui/ThemeProvider';

/**
 * An inline retry row.
 *
 * A failed read is a row in the list, never a screen: the rest of the tab still
 * works, and the user keeps whatever was already cached above it.
 */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      style={[
        styles.row,
        {
          backgroundColor: colors.dangerMuted,
          borderRadius: radius.sm,
          padding: spacing.md,
          gap: spacing.md,
        },
      ]}
    >
      <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
      <View style={{ flex: 1, gap: 1 }}>
        <Txt variant="caption" weight="600">
          Could not load tasks
        </Txt>
        <Txt variant="micro" tone="tertiary" numberOfLines={2}>
          {toAppError(error).userMessage}
        </Txt>
      </View>
      <Button label="Retry" size="sm" onPress={onRetry} />
    </View>
  );
}

/** The one-line inline error a sheet shows next to the control that caused it. */
export function InlineError({ message }: { message: string }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      style={[
        styles.row,
        {
          backgroundColor: colors.dangerMuted,
          borderRadius: radius.sm,
          padding: spacing.sm,
          gap: spacing.sm,
        },
      ]}
    >
      <Ionicons name="warning-outline" size={15} color={colors.danger} />
      <Txt variant="micro" tone="danger" style={{ flex: 1 }}>
        {message}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
