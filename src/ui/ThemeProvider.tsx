import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { makeTheme, type ColorScheme, type Theme } from './theme';

const ThemeContext = createContext<Theme>(makeTheme('dark'));

export function ThemeProvider({
  children,
  forceScheme,
}: {
  children: ReactNode;
  forceScheme?: ColorScheme;
}) {
  const system = useColorScheme();
  const scheme: ColorScheme = forceScheme ?? (system === 'light' ? 'light' : 'dark');
  const theme = useMemo(() => makeTheme(scheme), [scheme]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export function useColors() {
  return useContext(ThemeContext).colors;
}
