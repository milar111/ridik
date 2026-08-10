import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import type { typography } from '../theme';

type Variant = keyof typeof typography;
type Tone = 'primary' | 'secondary' | 'tertiary' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export type TxtProps = RNTextProps & {
  variant?: Variant;
  tone?: Tone;
  /** Overrides the variant's weight without restating the whole style. */
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
        { color: toneColor[tone] },
        weight ? { fontWeight: weight } : null,
        center ? { textAlign: 'center' } : null,
        dim ? { opacity: 0.6 } : null,
        style,
      ]}
    />
  );
}
