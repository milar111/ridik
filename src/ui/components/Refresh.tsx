/**
 * Pull-to-refresh, coloured once.
 *
 * `RefreshControl` is the one native widget here that cannot be redrawn without
 * reimplementing the gesture: iOS insets the scroll view and reveals a spinner
 * inside it, Android floats a circle in from above the content. The shape of
 * that is the platform's, and taking it away would cost more than it buys.
 *
 * What *was* ours and was being dropped is the colour. `tintColor` is read only
 * by iOS and `colors` / `progressBackgroundColor` only by Android, so a screen
 * that sets the first and not the others is themed on one platform and left at
 * Material's black-on-white default on the other — which is what two of the
 * three screens with a refresh were doing. One component, all three props.
 */
import { RefreshControl } from 'react-native';

import { useTheme } from '../ThemeProvider';

export function Refresh({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  const { colors } = useTheme();
  return (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      // iOS: the spinner itself.
      tintColor={colors.textTertiary}
      // Android: the arc, and the disc it turns on. An array because Material
      // cycles through them; one ember is the whole vocabulary here.
      colors={[colors.accent]}
      progressBackgroundColor={colors.surface}
    />
  );
}
