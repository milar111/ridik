/**
 * The sliding half of a bottom sheet, separated from the dimming half.
 *
 * `Modal animationType="slide"` moves the modal's *entire* content, and a
 * backdrop is part of that content — so the scrim travelled up the screen with
 * the card, and while it was in flight the top of the page was undimmed with a
 * hard horizontal edge across it. It reads as a rendering fault, because that
 * is what a straight line between two shades of the same page is.
 *
 * Splitting it in two is the whole fix: the `Modal` fades, which crossfades the
 * scrim over the full screen at once, and the card slides on its own transform
 * inside it. Two animations reaching the result one animation was asked for.
 *
 * A transform rather than a layout animation on purpose. Reanimated's
 * `entering`/`exiting` need a layout pass the React Native `Modal` does not
 * reliably give them — it is a separate native window, which is the same reason
 * gesture-handler needs its own root view inside one. A shared value driven
 * from an effect is what `Toggle` already uses and it works in both places.
 *
 * The progress itself comes from `useMountProgress`, so the mount-once
 * behaviour is the same primitive the rest of the app's in-`Modal` entrances
 * use. The style stays hand-written rather than `useMountRise`'s because of
 * `offset` — a caller dragging the sheet needs its translation added to the
 * entrance's, not fighting it on a second transform.
 */
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

import { useMountProgress } from '../motionHooks';

/** How far below its resting place the card starts. */
const TRAVEL = 28;

export function SheetCard({
  style,
  offset,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  /**
   * An extra translation the caller owns — a drag-to-dismiss. Added to the
   * entrance rather than layered as a second transform, so a pull that starts
   * before the sheet has settled moves the sheet it can see.
   */
  offset?: SharedValue<number>;
  children: ReactNode;
}) {
  // Starts down and rises once. The `Modal` mounts its content only while it is
  // open, so there is no "already shown" case to guard: every mount is an open.
  //
  // `SPRING_ENTER` (this hook's default) carries `reduceMotion:
  // ReduceMotion.System`, so this resolves to a still frame rather than a
  // faster slide for anyone who has asked the OS for one. A vestibular trigger
  // does not care about duration.
  const progress = useMountProgress();

  const motion = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (offset ? offset.value : 0) + (1 - progress.value) * TRAVEL }],
  }));

  return <Animated.View style={[style, motion]}>{children}</Animated.View>;
}
