import { Children } from 'react';
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

  // A card with nothing in it is never smaller — it is 24pt of painted,
  // bordered, rounded ground sitting in a list where the reader is looking for
  // a row, and that is exactly what it was photographed as. Nothing in this app
  // wants one: every `<Card>` in `app/` and `src/` has children, and about
  // thirty-five of them are a single `{rows.map(…)}` or `{cond ? … : null}`
  // that the caller is expected to have guarded. Most do. The ones that do not
  // cannot be found by reading, because it typechecks, it renders, and a test
  // with fixture data never reaches the state where every branch is false.
  //
  // So the surface refuses to paint itself rather than each of thirty-five
  // callers being asked to remember. `Children.toArray` is what makes it work:
  // it flattens the array a `.map` produces and drops `null`, `undefined` and
  // booleans, so a map over an empty list and a ternary that fell through both
  // arrive here as nothing at all.
  //
  // Deliberately below both hooks — a hook under an early return is the crash
  // in `AGENTS.md` that only fires on the render where the data transitions.
  if (Children.toArray(children).length === 0) return null;

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
