import { StyleSheet, View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../ThemeProvider';
import { AnimatedPressable, usePressScale } from '../motionHooks';
import { Spinner } from './Spinner';
import { Txt } from './Text';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export type ButtonProps = {
  label?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  variant?: Variant;
  size?: Size;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  haptic?: boolean;
  style?: ViewStyle;
  accessibilityLabel?: string;
  testID?: string;
};

const SIZES: Record<Size, { padV: number; padH: number; icon: number; variant: 'caption' | 'body' | 'bodyStrong' }> = {
  sm: { padV: 6, padH: 10, icon: 15, variant: 'caption' },
  md: { padV: 10, padH: 14, icon: 17, variant: 'bodyStrong' },
  lg: { padV: 14, padH: 18, icon: 20, variant: 'bodyStrong' },
};

export function Button({
  label,
  icon,
  onPress,
  variant = 'secondary',
  size = 'md',
  disabled,
  loading,
  fullWidth,
  haptic = true,
  style,
  accessibilityLabel,
  testID,
}: ButtonProps) {
  const { colors, radius } = useTheme();
  const dims = SIZES[size];

  const bg: Record<Variant, string> = {
    primary: colors.accent,
    secondary: colors.surfaceRaised,
    ghost: 'transparent',
    danger: colors.dangerMuted,
  };
  const fg: Record<Variant, string> = {
    primary: '#FFFFFF',
    secondary: colors.text,
    ghost: colors.textSecondary,
    danger: colors.danger,
  };
  const border: Record<Variant, string> = {
    primary: colors.accent,
    secondary: colors.border,
    ghost: 'transparent',
    danger: colors.dangerMuted,
  };

  const inactive = disabled || loading;
  // The press is a scale, not a dim: a button is the most-tapped surface in the
  // app and the one place where the finger deserves an answer with contact in
  // it. `opacity` stays static so the disabled 0.45 cannot be fought over.
  const press = usePressScale({ disabled: !!inactive });

  return (
    <AnimatedPressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      {...press.handlers}
      onPress={() => {
        if (haptic) void Haptics.selectionAsync().catch(() => {});
        onPress?.();
      }}
      style={[
        styles.base,
        {
          backgroundColor: bg[variant],
          borderColor: border[variant],
          borderRadius: radius.md,
          paddingVertical: dims.padV,
          paddingHorizontal: dims.padH,
          opacity: inactive ? 0.45 : 1,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
          justifyContent: 'center',
        },
        style,
        // Last: the transform must survive a caller's `style`, which is passed
        // for width and margin and never for a transform of its own.
        press.style,
      ]}
    >
      {loading ? (
        // Sized to the icon it stands in for, so a button does not change
        // height the moment it starts working.
        <Spinner size={dims.icon} color={fg[variant]} accessibilityLabel={label ?? 'Working'} />
      ) : (
        <View style={styles.row}>
          {icon ? <Ionicons name={icon} size={dims.icon} color={fg[variant]} /> : null}
          {label ? (
            <Txt variant={dims.variant} style={[styles.label, { color: fg[variant] }]}>
              {label}
            </Txt>
          ) : null}
        </View>
      )}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  // A button is as wide as its label. Without this it is the thing that gives
  // when a row runs out of space — Android shrinks it and clips the text rather
  // than wrapping the row, so "Export" arrived as "Exporl".
  base: { borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', flexShrink: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // Never shrinks, and carries a little slack on each side. Bricolage's `t` and
  // `e` have ink that reaches past their advance width, and Android clips a
  // Text to the advance — so "Export" lost its crossbar and "Delete" its last
  // stroke, while "Allow" and "See plans" were fine. Two points is enough for
  // the widest overhang in the face and is invisible next to the 10pt padding.
  label: { flexShrink: 0, paddingHorizontal: 2 },
});
