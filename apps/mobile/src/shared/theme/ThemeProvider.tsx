import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { usePreferencesStore } from '../../stores/preferences.store';
import { type ColorScheme, type Theme, themes } from './tokens';

const ThemeContext = createContext<Theme>(themes.light);

export function resolveScheme(
  preference: 'system' | ColorScheme,
  system: string | null | undefined,
): ColorScheme {
  if (preference !== 'system') return preference;
  return system === 'dark' ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const appearance = usePreferencesStore((state) => state.appearance);
  const theme = useMemo(
    () => themes[resolveScheme(appearance, systemScheme)],
    [appearance, systemScheme],
  );
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
