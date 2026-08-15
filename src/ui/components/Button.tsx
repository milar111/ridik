import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../ThemeProvider';
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

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={() => {
        if (haptic) void Haptics.selectionAsync().catch(() => {});
        onPress?.();
      }}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: bg[variant],
          borderColor: border[variant],
          borderRadius: radius.md,
          paddingVertical: dims.padV,
          paddingHorizontal: dims.padH,
          opacity: inactive ? 0.45 : pressed ? 0.75 : 1,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
          justifyContent: 'center',
        },
        style,
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
    </Pressable>
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
