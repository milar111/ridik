/**
 * `SheetCard`, for the surfaces that have no edge to come from.
 *
 * A bottom sheet rises because it is anchored to the bottom of the screen. A
 * centred dialog is not anchored to anything: sliding it means picking a
 * direction that means nothing, so it grows the last few per cent instead and
 * reads as arriving in front of the page. Same spring, same `Modal` fade
 * underneath it, same reason for using a shared value rather than `entering` —
 * see `SheetCard` for that story.
 *
 * The two surfaces this exists for are the two most interruptive in the app:
 * the confirm dialog, which is asked before something cannot be undone, and the
 * month picker. Both arrived completely flat, on the platform's scrim fade
 * alone, which is what made a destructive question feel like a screenshot.
 *
 * Props pass straight through to the card's own view rather than wrapping it in
 * a second one: the accessibility pair that traps a screen reader
 * (`accessibilityViewIsModal` on iOS, `accessibilityLiveRegion` on Android)
 * belongs on the element that draws the card, and an extra layout node between
 * a centring parent and a `width: '100%'` child is a resize waiting to happen.
 */
import type { ViewProps } from 'react-native';
import Animated from 'react-native-reanimated';

import { useMountPop } from '../motionHooks';

export function DialogCard({ style, children, ...rest }: ViewProps) {
  const motion = useMountPop();

  return (
    <Animated.View {...rest} style={[style, motion]}>
      {children}
    </Animated.View>
  );
}
