import { Pressable, StyleSheet, View, type ViewProps, type ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';

export type CardProps = ViewProps & {
  onPress?: () => void;
  onLongPress?: () => void;
  padded?: boolean;
  raised?: boolean;
  /** A 3px left rule — used to colour-code a card by tag or state. */
  accent?: string;
  style?: ViewStyle | ViewStyle[];
};

export function Card({
  children,
  onPress,
  onLongPress,
  padded = true,
  raised,
  accent,
  style,
  ...rest
}: CardProps) {
  const { colors, radius, spacing } = useTheme();

  const base: ViewStyle = {
    backgroundColor: raised ? colors.surfaceRaised : colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: padded ? spacing.md : 0,
    overflow: 'hidden',
  };

  const content = (
    <View {...rest} style={[base, accent ? { borderLeftWidth: 3, borderLeftColor: accent } : null, style]}>
      {children}
    </View>
  );

  if (!onPress && !onLongPress) return content;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {content}
    </Pressable>
  );
}

export function Divider({ inset = 0 }: { inset?: number }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: colors.border,
        marginLeft: inset,
      }}
    />
  );
}
