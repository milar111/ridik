import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import { Button, Txt } from '@/ui/components';

/**
 * The failure a home screen is allowed to have: one row, still inside the
 * scroll view, with the way out attached. A tab the user opens fifty times a
 * day must never greet them with a stack trace.
 */
export function InlineError({
  message,
  onRetry,
  testID,
}: {
  message: string;
  onRetry: () => void;
  testID?: string;
}) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      testID={testID}
      // A View is not `accessible` by default, so the role alone announces nothing.
      accessible
      accessibilityRole="alert"
      style={[
        styles.row,
        {
          backgroundColor: colors.dangerMuted,
          borderRadius: radius.sm,
          paddingHorizontal: spacing.md,
          gap: spacing.sm,
        },
      ]}
    >
      <Ionicons name="alert-circle-outline" size={17} color={colors.danger} />
      <Txt variant="caption" tone="danger" style={{ flex: 1 }} numberOfLines={2}>
        {message}
      </Txt>
      {/* `sm` keeps the row compact; the min height keeps the target at 44. */}
      <Button label="Retry" size="sm" variant="ghost" style={styles.retry} onPress={onRetry} />
    </View>
  );
}

/**
 * Scopes a crash to one section.
 *
 * The default boundary screen is full-bleed, which inside a scrolling home
 * screen would read as "the app died" when in fact one list of rows did.
 */
export function SectionBoundary({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <ErrorBoundary
      label={`today:${label}`}
      fallback={(error, reset) => (
        <InlineError message={`${label} could not be shown. ${error.message}`} onRetry={reset} />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  retry: { minHeight: 44 },
});
