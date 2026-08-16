import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { formatTime } from '@/core/time';
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
 * The day is still on screen, but it has stopped being fresh.
 *
 * React Query keeps the last good snapshot when a refetch fails, which is
 * exactly the right behaviour and exactly the wrong silence: the screen goes on
 * showing a day that may now be wrong — an event moved on another device, a
 * task completed on the phone in your other hand — with nothing to say so. That
 * is worse than an error, because a stale day looks precisely like a current
 * one.
 *
 * So it is stated, and stated quietly. Not `dangerMuted` and not an `alert`
 * role: nothing has broken, nothing has been lost, and the day on screen is
 * still probably right. What the user needs is the timestamp — the one fact
 * that turns "this looks fine" into "this is from an hour ago" — and a way to
 * try again. It announces itself as one sentence to a screen reader rather than
 * as three unrelated fragments, and the time carries the zone the snapshot was
 * built in so a day cached in one timezone does not claim to be an hour in
 * another.
 */
export function StaleNotice({
  at,
  zone,
  onRetry,
  testID,
}: {
  at: number;
  zone?: string;
  onRetry: () => void;
  testID?: string;
}) {
  const { colors, radius, spacing } = useTheme();
  const shown = formatTime(at, zone);
  const message = `Showing your day as it was at ${shown}. It could not be refreshed just now.`;

  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={message}
      style={[
        styles.row,
        {
          backgroundColor: colors.surfaceSunken,
          borderRadius: radius.sm,
          paddingHorizontal: spacing.md,
          gap: spacing.sm,
        },
      ]}
    >
      <Ionicons name="cloud-offline-outline" size={16} color={colors.textTertiary} />
      <Txt variant="micro" tone="tertiary" style={{ flex: 1 }}>
        {message}
      </Txt>
      <Button label="Refresh" size="sm" variant="ghost" style={styles.retry} onPress={onRetry} />
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
