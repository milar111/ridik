import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../ThemeProvider';
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
        <ActivityIndicator size="small" color={fg[variant]} />
      ) : (
        <View style={styles.row}>
          {icon ? <Ionicons name={icon} size={dims.icon} color={fg[variant]} /> : null}
          {label ? (
            <Txt variant={dims.variant} style={{ color: fg[variant] }}>
              {label}
            </Txt>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { borderWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
