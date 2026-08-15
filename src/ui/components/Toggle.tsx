/**
 * The app's switch, because React Native's is two switches.
 *
 * `Switch` is a `UISwitch` on iOS and a Material 3 `SwitchCompat` on Android:
 * different sizes, different travel, different thumb, and on Android a track
 * that pulls its own tint from the system theme and paints a check glyph inside
 * the thumb once it is on. `trackColor` and `thumbColor` can recolour parts of
 * that, which only makes the two look like the same wrong control in the right
 * palette. Nothing about the shape was ever ours.
 *
 * This one is: a raised surface riding in a sunken groove that warms to the
 * accent, sized and sprung from the same tokens as everything else. The props
 * are the ones `Switch` was actually being given, so the call site changed by a
 * word — and `SwitchRow`, which is what the screens see, did not change at all.
 */
import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import { useTheme } from '../ThemeProvider';
import { tap } from '../motion';
import { elevate } from '../shadow';

const TRACK_W = 46;
const TRACK_H = 28;
const INSET = 3;
const THUMB = TRACK_H - INSET * 2;
const TRAVEL = TRACK_W - THUMB - INSET * 2;

export type ToggleProps = {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
};

export function Toggle({
  value,
  onValueChange,
  disabled,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: ToggleProps) {
  const { colors, radius } = useTheme();
  const on = useSharedValue(value ? 1 : 0);

  // `SPRING_TAP` carries `ReduceMotion.System`, so a user who has asked the OS
  // to stop animations gets the end state without this file knowing about it.
  useEffect(() => {
    on.value = tap(value ? 1 : 0);
  }, [value, on]);

  // The lit track is a second layer fading in over the groove rather than an
  // interpolated colour: one fewer worklet, and the groove's border stays put
  // underneath instead of being crossfaded along with the fill.
  const litStyle = useAnimatedStyle(() => ({ opacity: on.value }));
  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: on.value * TRAVEL }] }));

  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      onPress={() => {
        void Haptics.selectionAsync().catch(() => {});
        onValueChange(!value);
      }}
      // The track is 46×28 and the row around it is not always tappable, so the
      // slop is what brings this to a 44pt target.
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={[
        styles.track,
        {
          borderRadius: radius.pill,
          backgroundColor: colors.surfaceSunken,
          borderColor: colors.borderStrong,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: radius.pill, backgroundColor: colors.accent },
          litStyle,
        ]}
      />
      <Animated.View
        pointerEvents="none"
        style={[
          styles.thumb,
          elevate('card'),
          { backgroundColor: colors.surfaceRaised, borderColor: colors.border },
          thumbStyle,
        ]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: TRACK_W,
    height: TRACK_H,
    borderWidth: StyleSheet.hairlineWidth,
    // Deliberately not `overflow: hidden` — the lit layer carries its own pill
    // radius, and clipping here would cut the thumb's shadow off at the groove.
  },
  // Both layers are placed rather than laid out. Padding plus a flex child
  // would put the thumb's resting position at the mercy of how each renderer
  // resolves an absolute sibling against a padding box, which is the kind of
  // three-point difference this whole component exists to avoid.
  thumb: {
    position: 'absolute',
    top: INSET,
    left: INSET,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
