import { StyleSheet, View, type ViewProps, type ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { AnimatedPressable, usePressScale } from '../motionHooks';

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
  // Shallower than the 0.96 default: a card is most of the screen's width, and
  // the same proportional travel that reads as contact on a chip reads as the
  // whole page flinching on something this big. Called unconditionally — a card
  // without `onPress` still renders through the same hook order.
  const press = usePressScale({ scale: 0.98 });

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
    <AnimatedPressable
      accessibilityRole="button"
      onPress={onPress}
      onLongPress={onLongPress}
      {...press.handlers}
      style={press.style}
    >
      {content}
    </AnimatedPressable>
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
