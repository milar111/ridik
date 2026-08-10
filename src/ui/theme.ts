/**
 * Design tokens.
 *
 * The brief asks for a utilitarian, high-density, zero-decoration interface:
 * near-black ground, one saturated accent for the voice affordance, and type
 * that stays legible at a glance while walking. Everything else is greyscale so
 * colour only ever means *state*.
 */
import { Platform } from 'react-native';

export type ColorScheme = 'light' | 'dark';

const palette = {
  violet: '#7C5CFF',
  violetDim: '#5B41C7',
  mint: '#2FD98A',
  amber: '#FFB020',
  red: '#FF5A5F',
  cyan: '#3FC1FF',
};

export type Colors = {
  bg: string;
  surface: string;
  surfaceRaised: string;
  surfaceSunken: string;
  border: string;
  borderStrong: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  accentMuted: string;
  success: string;
  successMuted: string;
  warning: string;
  warningMuted: string;
  danger: string;
  dangerMuted: string;
  info: string;
  infoMuted: string;
  overlay: string;
};

export const darkColors: Colors = {
  bg: '#0B0B0F',
  surface: '#141419',
  surfaceRaised: '#1C1C23',
  surfaceSunken: '#08080B',
  border: '#26262F',
  borderStrong: '#3A3A46',
  text: '#F2F2F5',
  textSecondary: '#A0A0AE',
  textTertiary: '#6C6C7A',
  accent: palette.violet,
  accentMuted: 'rgba(124, 92, 255, 0.16)',
  success: palette.mint,
  successMuted: 'rgba(47, 217, 138, 0.14)',
  warning: palette.amber,
  warningMuted: 'rgba(255, 176, 32, 0.14)',
  danger: palette.red,
  dangerMuted: 'rgba(255, 90, 95, 0.14)',
  info: palette.cyan,
  infoMuted: 'rgba(63, 193, 255, 0.14)',
  overlay: 'rgba(0, 0, 0, 0.6)',
};

export const lightColors: Colors = {
  bg: '#FBFBFD',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  surfaceSunken: '#F1F1F5',
  border: '#E3E3EA',
  borderStrong: '#C9C9D4',
  text: '#111116',
  textSecondary: '#5A5A68',
  textTertiary: '#8B8B99',
  accent: palette.violetDim,
  accentMuted: 'rgba(91, 65, 199, 0.10)',
  success: '#12A05E',
  successMuted: 'rgba(18, 160, 94, 0.10)',
  warning: '#B26A00',
  warningMuted: 'rgba(178, 106, 0, 0.10)',
  danger: '#D63A3F',
  dangerMuted: 'rgba(214, 58, 63, 0.10)',
  info: '#0C7FB8',
  infoMuted: 'rgba(12, 127, 184, 0.10)',
  overlay: 'rgba(15, 15, 20, 0.35)',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

const systemFont = Platform.select({
  ios: 'System',
  android: 'sans-serif',
  default: 'System',
});

const monoFont = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

export const typography = {
  display: { fontSize: 30, lineHeight: 36, fontWeight: '700', fontFamily: systemFont },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700', fontFamily: systemFont },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: '600', fontFamily: systemFont },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400', fontFamily: systemFont },
  bodyStrong: { fontSize: 15, lineHeight: 21, fontWeight: '600', fontFamily: systemFont },
  caption: { fontSize: 13, lineHeight: 17, fontWeight: '400', fontFamily: systemFont },
  micro: { fontSize: 11, lineHeight: 14, fontWeight: '600', fontFamily: systemFont },
  mono: { fontSize: 14, lineHeight: 18, fontWeight: '500', fontFamily: monoFont },
  timer: { fontSize: 56, lineHeight: 62, fontWeight: '200', fontFamily: monoFont },
} as const;

export type Theme = {
  scheme: ColorScheme;
  colors: Colors;
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
};

export function makeTheme(scheme: ColorScheme): Theme {
  return {
    scheme,
    colors: scheme === 'dark' ? darkColors : lightColors,
    spacing,
    radius,
    typography,
  };
}

/** Deterministic accent for a tag/category so colour is stable across sessions. */
const TAG_COLORS = [
  palette.violet,
  palette.mint,
  palette.cyan,
  palette.amber,
  '#FF7AB6',
  '#8AE68A',
  '#FFA07A',
  '#9C8CFF',
];

export function colorForTag(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
  return TAG_COLORS[hash % TAG_COLORS.length]!;
}
