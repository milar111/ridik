import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { fonts, type typography } from '../theme';

type Variant = keyof typeof typography;
type Tone = 'primary' | 'secondary' | 'tertiary' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/**
 * Weight is a different family, not a `fontWeight`.
 *
 * Once a style names a font file, `fontWeight` is ignored outright on iOS and
 * synthesised on Android by smearing the glyphs — so the same label would look
 * bold on one platform, unchanged on the other, and correct on neither. The
 * prop is kept because call sites read better with it; what it does changed.
 */
const WEIGHT_FAMILY: Record<string, string> = {
  '400': fonts.regular,
  '500': fonts.medium,
  '600': fonts.semibold,
  '700': fonts.bold,
  '800': fonts.display,
};

/**
 * The metric every variant shares. Kept out of `typography` so the scale stays
 * a description of the faces rather than a list of platform corrections.
 */
const BASE: TextStyle = { includeFontPadding: false };

export type TxtProps = RNTextProps & {
  variant?: Variant;
  tone?: Tone;
  /** Swaps the family for a heavier cut of the same face. */
  weight?: TextStyle['fontWeight'];
  center?: boolean;
  dim?: boolean;
};

export function Txt({
  variant = 'body',
  tone = 'primary',
  weight,
  center,
  dim,
  style,
  ...rest
}: TxtProps) {
  const theme = useTheme();
  const c = theme.colors;
  const toneColor: Record<Tone, string> = {
    primary: c.text,
    secondary: c.textSecondary,
    tertiary: c.textTertiary,
    accent: c.accent,
    success: c.success,
    warning: c.warning,
    danger: c.danger,
    info: c.info,
  };

  return (
    <RNText
      {...rest}
      style={[
        theme.typography[variant] as TextStyle,
        // Android pads every line by the font's own top/bottom metrics on top
        // of the `lineHeight` the scale sets, so the same label sits a couple
        // of points lower in a taller box than on iOS — visible the moment it
        // is centred against an icon, and cumulative down a stack of rows.
        // iOS has no such notion and ignores this outright.
        BASE,
        { color: toneColor[tone] },
        // Only for the grotesque: asking the mono for a bold cut it was not
        // given would silently fall back to the system face mid-sentence.
        weight && WEIGHT_FAMILY[String(weight)] && !theme.typography[variant].fontFamily.startsWith('Martian')
          ? { fontFamily: WEIGHT_FAMILY[String(weight)] }
          : null,
        center ? { textAlign: 'center' } : null,
        dim ? { opacity: 0.6 } : null,
        style,
      ]}
    />
  );
}
