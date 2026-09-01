/**
 * The mark, coming up to temperature.
 *
 * `expo-splash-screen` can only hold a *still* image, so a cold start used to
 * end with the static mark vanishing and home simply existing — the one moment
 * in the app where nothing moved. This continues that image instead of
 * replacing it: the curtain opens on exactly the five cold cells the native
 * splash was already showing, warms them left to right, lets the fourth stand
 * up and ignite, and dissolves onto a home screen whose `HeatField` is already
 * glowing behind it.
 *
 * **`splash-icon.png` is therefore the mark *cold*** — see `scripts/icons.py`,
 * which cuts it from the same geometry with no cell lit and none risen. That is
 * a real constraint, not a nicety: the first frame drawn here has to be the
 * image the native splash was holding, at the same opacity and the same scale.
 * Ship the finished logo as the splash and the launch plays backwards, arriving
 * hot, resetting to cold and heating a second time — which is exactly what it
 * did on the first device run, and is the reason nothing here fades or scales
 * *in*. Only colour and one height move.
 *
 * It is the product's own sentence, animated. Five heat cells with the fourth
 * burning is the mark; "an element coming up to temperature, not a sunset" is
 * the design language; and the tall cell is the next thing on your day, which
 * is the question the app exists to answer. Nothing here is decoration
 * borrowed from somewhere else.
 *
 * ## It is an overlay, never a gate
 *
 * The same rule `ConsentGate` and the bootstrap overlay follow, for the same
 * reason: the navigator has to mount on the very first render or expo-router
 * resolves the launch URL against an empty tree. So this draws *over* a live
 * app rather than standing in front of one, and it never delays a launch — it
 * starts when the native splash lets go and gets out of the way on its own.
 * `pointerEvents="none"` from the first frame: a tap meant for the microphone
 * lands on the microphone even mid-dissolve.
 *
 * ## Reduced motion
 *
 * A vestibular trigger does not care that the movement was short. With reduce
 * motion on, the cells are painted at their final heat with no travel and the
 * curtain simply fades, which is the same end state a second later.
 */
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  type SharedValue,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '@/ui/ThemeProvider';

/**
 * The mark's proportions, in the same units `scripts/icons.py` draws it in, so
 * the animation opens on the frame the native splash was holding rather than
 * on something a few points off it. Only the ratios travel: the curtain sizes
 * itself from `MARK_W` below.
 */
const CELL_W = 104;
const GAP = 32;
const CELL_H = 356;
const HOT_H = 540;
const COUNT = 5;
const HOT = 3;

/** The square `splash-icon.png` is cut from, not the mark's own width. */
const CANVAS = 1024;

/**
 * `imageWidth` in `app.config.ts` — and it sizes the **image**, not the mark.
 *
 * This is the whole reason the handover used to flinch. `splash-icon.png` is a
 * 1024-square with the mark filling 648 of it, so a 180dp `imageWidth` puts the
 * mark on screen at 180 x 648/1024 — about 114dp. Scaling by the mark's own
 * width instead drew it here at the full 180, a little over half again as big,
 * and the two crossed over each other as one shape swelling into another. Both
 * marks were correct; only one of them was the size the other was.
 *
 * So the divisor is the canvas, never `UNIT`. If `imageWidth` moves, this
 * follows it and nothing else has to.
 */
const MARK_W = 180;
const SCALE = MARK_W / CANVAS;

/** Which heat each cell settles at. Indices into the theme's four-step ramp. */
const LEVEL = ['cold', 'low', 'mid', 'hot', 'cold'] as const;

/**
 * A cell warms in the order the day runs, so the eye is carried left to right
 * and arrives at the tall one. 45ms is close enough to read as one gesture and
 * far enough apart to read as five things — it was 70, which read as five
 * separate events on a launch that is already over in a second.
 *
 * The whole run is about 870ms. It is a launch, and a launch that announces
 * itself is a launch you notice twice.
 */
const STAGGER_MS = 45;
const WARM_MS = 190;
/** The fourth cell stands up *after* it has caught, not while. */
const RISE_DELAY_MS = STAGGER_MS * HOT + 80;
const RISE_MS = 340;
/** Long enough to be seen at the top of its rise before anything dissolves. */
const HOLD_MS = 150;
const FADE_MS = 300;

export function SplashCurtain({ onDone }: { onDone: () => void }) {
  const theme = useTheme();
  const reduced = useReducedMotion();

  // One value per cell for the warm, one for the rise, one for the whole
  // curtain. Separate rather than a single clock because the rise has to lag
  // its own cell's warm, and a single progress value would have to encode that
  // relationship twice — once here and once in every interpolation.
  const warm = useSharedValue(reduced ? 1 : 0);
  const rise = useSharedValue(reduced ? 1 : 0);
  const veil = useSharedValue(1);

  useEffect(() => {
    const settle = () => {
      'worklet';
      runOnJS(onDone)();
    };

    if (reduced) {
      veil.value = withDelay(HOLD_MS, withTiming(0, { duration: FADE_MS }, settle));
      return;
    }

    warm.value = withTiming(1, {
      duration: WARM_MS + STAGGER_MS * (COUNT - 1),
      easing: Easing.out(Easing.cubic),
    });
    rise.value = withDelay(
      RISE_DELAY_MS,
      // `back` is the one overshoot in here: an element coming up to heat
      // expands past where it settles. Kept small — this is a launch, not a toy.
      withTiming(1, { duration: RISE_MS, easing: Easing.out(Easing.back(1.4)) }),
    );
    veil.value = withDelay(
      RISE_DELAY_MS + RISE_MS + HOLD_MS,
      withTiming(0, { duration: FADE_MS, easing: Easing.in(Easing.quad) }, settle),
    );
  }, [reduced, warm, rise, veil, onDone]);

  const sheet = useAnimatedStyle(() => ({ opacity: veil.value }));

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, styles.sheet, { backgroundColor: theme.colors.bg }, sheet]}
    >
      <View style={styles.row}>
        {LEVEL.map((level, index) => (
          <Cell
            key={index}
            index={index}
            level={level}
            warm={warm}
            rise={rise}
            cold={theme.cells.cold}
            lit={theme.cells[level]}
          />
        ))}
      </View>
    </Animated.View>
  );
}

function Cell({
  index,
  level,
  warm,
  rise,
  cold,
  lit,
}: {
  index: number;
  level: (typeof LEVEL)[number];
  warm: SharedValue<number>;
  rise: SharedValue<number>;
  cold: string;
  lit: string;
}) {
  const isHot = index === HOT;
  const base = CELL_H * SCALE;
  const tall = HOT_H * SCALE;

  const style = useAnimatedStyle(() => {
    // This cell's slice of the sweep, in the whole run's 0..1.
    const span = WARM_MS + STAGGER_MS * (COUNT - 1);
    const from = (STAGGER_MS * index) / span;
    const to = from + WARM_MS / span;
    const t = Math.min(1, Math.max(0, (warm.value - from) / (to - from)));

    return {
      // Colour is a swap at the midpoint rather than an interpolation: this
      // palette's steps are the four levels the whole app speaks in, and a
      // blend between two of them is a fifth colour that exists nowhere else.
      backgroundColor: t > 0.5 ? lit : cold,
      // The one height that moves. Everything else is already where the native
      // splash left it — no opacity ramp and no scale, or the first frame would
      // not match the image underneath it.
      height: isHot ? base + (tall - base) * rise.value : base,
    };
  });

  return (
    <Animated.View
      style={[
        {
          width: CELL_W * SCALE,
          borderRadius: (CELL_W * SCALE) / 2,
          marginLeft: index === 0 ? 0 : GAP * SCALE,
        },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  sheet: { alignItems: 'center', justifyContent: 'center' },
  // Centre on the middle of every cell so the fourth grows both ways, exactly
  // as it is drawn in the icon.
  row: { flexDirection: 'row', alignItems: 'center', height: HOT_H * SCALE },
});
