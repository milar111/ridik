/**
 * The dimming and the ring, over whatever the tour is pointing at.
 *
 * Rendered once, from the root layout, which covers every screen the walk
 * visits. It has to stay there: a copy of this was once rendered inside the
 * menu sheet as well, because a sibling of `<Stack>` is *underneath* a
 * presented screen and the ring landed behind the menu — and that copy needed
 * its own coordinate space, its own settling logic and its own scroll
 * tracking, all of which went wrong in a different way each time. The walk does
 * not visit the menu any more, and none of it is needed.
 */
import { useEffect } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '@/ui/ThemeProvider';

import type { TourFrame } from './TourContext';

/** Breathing room between the ring and the thing it rings. */
export const RING_PAD = 10;
/** How long the spotlight takes to travel between two controls. */
export const MOVE_MS = 420;
/**
 * How a spotlight moves: quickly away, slowly into place.
 *
 * Reanimated's default is a symmetrical ease, which at this distance reads as a
 * mechanism sliding rather than as attention being moved. Everything the tour
 * animates is eased on a cubic for the same reason — the complaint that started
 * this was "it should be smooth and non-linear".
 */
const TRAVEL = Easing.out(Easing.cubic);
/** In fast, out slow: a cover should arrive before it is noticed and leave visibly. */
const COVER_IN = Easing.in(Easing.cubic);
const COVER_OUT = Easing.out(Easing.cubic);
/** How long the curtain takes to close over an outgoing screen. */
export const COVER_IN_MS = 260;
/** And to open on the one that replaced it. */
export const COVER_OUT_MS = 420;
/**
 * How much of the dimming is left on a step with nothing to ring.
 *
 * Those steps are the walk — "this is the Money screen" — and their whole job
 * is to let somebody *look at the screen*. Pressing it to the same depth as a
 * spotlight hides the thing the sentence is pointing at.
 */
const SOFT_SCRIM = 0.55;

/**
 * The dimming, as **one view with an enormous border**.
 *
 * The hole is the view's content box; the scrim is its border. RN follows CSS
 * here — the inner edge of a border is rounded at `borderRadius - borderWidth`
 * — so a border of `B` and a radius of `r + B` leaves a hole whose corners are
 * exactly `r`. One view, one edge, and the same construction whether the hole
 * is a circle or a rounded rectangle.
 *
 * Two earlier attempts look right in a still and are not. Four rectangles
 * around the hole leave a **square** cut-out with a circular ring floating
 * inside it — four bright corners past the ring, which reads as a rendering
 * fault. Adding four rounded corner pieces fixes the shape and introduces a
 * hairline of undimmed screen at twelve, three, six and nine o'clock where the
 * pieces abut and antialiasing leaves each edge partly transparent; rounding
 * the coordinates does not help, because the gap is in the coverage of a curve
 * rather than in the arithmetic.
 *
 * It **moves** between steps rather than cutting. Three of the four home steps
 * ring something a third of a screen from the last one, and a hole that jumps
 * reads as a new overlay each time rather than as one thing being pointed at.
 */
export function Spotlight({
  frame,
  soft,
  reduced,
}: {
  frame: TourFrame | undefined;
  soft: boolean;
  reduced: boolean;
}) {
  const { colors, radius, scheme } = useTheme();
  /*
   * The ring is pale in *both* themes, and it has to be named twice to be.
   *
   * `colors.surface` is linen in light and a dark brown in dark, so using it
   * alone drew a dark line along the edge of a dark scrim — the one boundary
   * the ring exists to describe, and the one place it disappeared. What the
   * ring is separating is always the same two things: a lit hole and a dimmed
   * screen, and the dimming is dark in both themes.
   */
  const edge = scheme === 'dark' ? colors.text : colors.surface;
  const screen = useWindowDimensions();
  // Wide enough that the border still reaches every edge with the hole in the
  // far corner. Cheap: it is one view, and it is the only one.
  const b = Math.ceil(screen.width + screen.height);

  const x = useSharedValue(frame?.x ?? screen.width / 2);
  const y = useSharedValue(frame?.y ?? screen.height / 2);
  const w = useSharedValue(frame?.width ?? 0);
  const h = useSharedValue(frame?.height ?? 0);
  /*
   * The padding is animated too, and it has to be.
   *
   * A hole of zero size is still `RING_PAD` on each side, so closing one by
   * shrinking the frame alone leaves a 20pt disc of undimmed screen sitting in
   * the middle of every step that has nothing to point at — which reads as a
   * speck of dirt on the lens rather than as anything deliberate.
   */
  const pad = useSharedValue(frame ? RING_PAD : 0);
  /*
   * How hard the scrim presses.
   *
   * Full strength when there is something to look at, because that is what a
   * spotlight is for. Much lighter on a step whose whole point is "here is the
   * Money screen" — dimming that to the same depth hides the thing the sentence
   * is asking the reader to look at. `soft` is the step's own declaration, not
   * "no frame arrived": see the note where it is computed.
   */
  const press = useSharedValue(frame || !soft ? 1 : SOFT_SCRIM);

  useEffect(() => {
    // A step with no target closes the hole where it stands rather than
    // sliding it off to a corner, which would drag the eye somewhere there is
    // nothing to see.
    const to = {
      x: frame ? frame.x : x.value + w.value / 2,
      y: frame ? frame.y : y.value + h.value / 2,
      width: frame?.width ?? 0,
      height: frame?.height ?? 0,
    };
    const ease = reduced ? { duration: 0 } : { duration: MOVE_MS, easing: TRAVEL };
    x.value = withTiming(to.x, ease);
    y.value = withTiming(to.y, ease);
    w.value = withTiming(to.width, ease);
    h.value = withTiming(to.height, ease);
    press.value = withTiming(frame || !soft ? 1 : SOFT_SCRIM, ease);
    pad.value = withTiming(frame ? RING_PAD : 0, ease);
  }, [frame, soft, reduced, x, y, w, h, pad, press]);

  /** Circle for a disc, the card radius for anything longer than it is tall. */
  const corner = useDerivedValue(() => {
    const width = w.value + pad.value * 2;
    const height = h.value + pad.value * 2;
    return Math.abs(width - height) < 8 ? width / 2 : radius.md;
  });

  const hole = useAnimatedStyle(() => ({
    top: y.value - pad.value - b,
    left: x.value - pad.value - b,
    width: w.value + pad.value * 2 + b * 2,
    height: h.value + pad.value * 2 + b * 2,
    borderRadius: corner.value + b,
    opacity: press.value,
  }));

  const ring = useAnimatedStyle(() => ({
    top: y.value - pad.value,
    left: x.value - pad.value,
    width: w.value + pad.value * 2,
    height: h.value + pad.value * 2,
    borderRadius: corner.value,
    // A ring around a hole of no size is a dot on an empty screen.
    opacity: w.value > 1 ? 1 : 0,
  }));

  return (
    <>
      <Animated.View
        pointerEvents="none"
        style={[styles.abs, { borderWidth: b, borderColor: colors.overlay }, hole]}
      />
      <Animated.View
        pointerEvents="none"
        style={[styles.abs, { borderWidth: 2, borderColor: edge }, ring]}
      />
    </>
  );
}

const styles = StyleSheet.create({ abs: { position: 'absolute' } });

/* ----------------------------------------------------------------- curtain -- */

/**
 * An opaque cover, so a route change is a cross-fade rather than a cut.
 *
 * The walk opens nine screens and the navigator gives each one a hard swap: on
 * a sheet being replaced there is no transition at all, so what a viewer sees
 * is a flash — nine of them, one every couple of seconds, which is what made a
 * deliberate tour look broken. Nothing here can change how the navigator
 * animates a `replace`, and it does not have to: the swap happens *behind* this,
 * at the app's own ground colour, and the two screens fade through it.
 *
 * The colour matters. A black cover reads as the app closing; the ground the
 * whole product is painted on reads as one screen becoming another.
 */
export function Curtain({ up, reduced }: { up: boolean; reduced: boolean }) {
  const { colors } = useTheme();
  const shade = useSharedValue(up ? 1 : 0);

  useEffect(() => {
    shade.value = withTiming(
      up ? 1 : 0,
      reduced
        ? { duration: 0 }
        : up
          ? { duration: COVER_IN_MS, easing: COVER_IN }
          : { duration: COVER_OUT_MS, easing: COVER_OUT },
    );
  }, [up, reduced, shade]);

  const style = useAnimatedStyle(() => ({ opacity: shade.value }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }, style]}
    />
  );
}
