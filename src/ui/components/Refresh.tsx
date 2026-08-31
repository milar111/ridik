/**
 * Pull-to-refresh, coloured once — as a hook, and that is the whole point.
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
 * three screens with a refresh were doing. One place, all three props.
 *
 * ## Why this is a hook and not a component
 *
 * It was a component, `<Refresh />`, and that cost three screens their content
 * on Android for as long as it existed.
 *
 * `refreshControl` is not an ordinary child. On Android, React Native reads that
 * element to build the `AndroidSwipeRefreshLayout` the scroll view lives inside,
 * and it expects a `RefreshControl` *element* — not a component that happens to
 * render one. Given a wrapper it cannot recognise, the content measures to
 * nothing: `Today` and `Projects` rendered an empty page with no header, no
 * rows, no error and nothing in the view tree to inspect, and `Tasks` — whose
 * `Screen` is `scroll={false}`, so only its inner list was affected — merely
 * looked like it had no tasks. iOS renders the wrapper correctly, which is why
 * this survived: the screens were fine on the platform they were checked on.
 *
 * A hook returning an element is unusual, and it is what makes the difference
 * safe. `useRefresh()` needs the theme, so it cannot be a plain function; and
 * because what reaches `refreshControl` is the `RefreshControl` element itself,
 * there is no wrapper left for the platform to fail to recognise. Call it at the
 * top of the component and hand the result over:
 *
 *     const refreshControl = useRefresh({ refreshing, onRefresh });
 *     return <Screen refreshControl={refreshControl}>…</Screen>;
 *
 * Never re-export this as a component for convenience. The failure it caused is
 * invisible on the platform most of this app is checked on, and silent on the
 * one it breaks.
 */
import type { ReactElement } from 'react';
import { RefreshControl, type RefreshControlProps } from 'react-native';

import { useTheme } from '../ThemeProvider';

/**
 * The return type is deliberately `ReactElement<RefreshControlProps>` rather
 * than a bare `ReactElement`: it makes the substitution this file exists to
 * prevent — handing a scroll view something that merely *renders* a refresh
 * control — fail to type-check rather than fail silently on one platform.
 */
export function useRefresh({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}): ReactElement<RefreshControlProps> {
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
