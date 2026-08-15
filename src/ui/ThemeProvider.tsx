import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

import { loadEmber, useEmberChoice } from '@/hooks/useEmber';

import { makeTheme, type ColorScheme, type EmberName, type Theme } from './theme';

const ThemeContext = createContext<Theme>(makeTheme('dark'));

export function ThemeProvider({
  children,
  forceScheme,
  forceEmber,
}: {
  children: ReactNode;
  forceScheme?: ColorScheme;
  /** For tests and for previews; the app always follows the stored setting. */
  forceEmber?: EmberName;
}) {
  const system = useColorScheme();
  const scheme: ColorScheme = forceScheme ?? (system === 'light' ? 'light' : 'dark');
  const chosen = useEmberChoice();
  const ember = forceEmber ?? chosen;

  // The stored ember, once. Not a query: this provider is mounted above the
  // query client — see `useEmber` — and the value it produces is needed on the
  // first frame of every screen, including the boot overlay.
  useEffect(() => {
    void loadEmber();
  }, []);

  const theme = useMemo(() => makeTheme(scheme, ember), [scheme, ember]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export function useColors() {
  return useContext(ThemeContext).colors;
}
