import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { countLabel } from '@/core/format';
import type { TodaySync } from '@/hooks';
import { Badge, Button } from '@/ui/components';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';

/**
 * The two places Today does not itself go, plus the outbox.
 *
 * The sync badge only appears when there is something to say: everything is
 * written locally first, so a quiet badge is the normal state and a permanent
 * "synced" tick would be pure decoration. A write that has *failed* is not
 * still syncing, and saying so would leave the user waiting on something that
 * has stopped — so it reads as a failure and goes to the outbox in Settings.
 */
export function TodayHeaderActions({ sync }: { sync?: TodaySync }) {
  const router = useRouter();
  // Called whether or not the badge is drawn: a hook behind the `label ?` would
  // change the hook order the first time a sync failed.
  const press = usePressScale();

  const failed = sync?.failed ?? 0;
  const badge = sync?.badge ?? 0;
  const label = failed > 0 ? `${countLabel(failed, 'failure')}` : badge > 0 ? `Syncing ${badge}` : null;

  return (
    <View style={styles.row}>
      {label ? (
        <AnimatedPressable
          accessibilityRole="button"
          accessibilityLabel={
            failed > 0
              ? `${countLabel(failed, 'sync failure')}. Opens settings`
              : `${countLabel(badge, 'change')} waiting to sync. Opens settings`
          }
          // Slop is measured against the layout box, which the transform leaves
          // where it was — the target stays 44pt however far the badge sinks.
          hitSlop={12}
          onPress={() => router.push('/settings')}
          {...press.handlers}
          style={press.style}
          testID="today-sync-badge"
        >
          <Badge label={label} tone={failed > 0 ? 'danger' : 'warning'} />
        </AnimatedPressable>
      ) : null}
      <Button
        icon="sparkles-outline"
        variant="ghost"
        accessibilityLabel="Your briefing"
        onPress={() => router.push('/briefing')}
        style={styles.iconButton}
        testID="today-briefing-button"
      />
      <Button
        icon="ellipsis-horizontal"
        variant="ghost"
        accessibilityLabel="More"
        onPress={() => router.push('/menu')}
        style={styles.iconButton}
        testID="today-more-button"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  iconButton: { minWidth: 44, minHeight: 44, paddingHorizontal: 0 },
});
