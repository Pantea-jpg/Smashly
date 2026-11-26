import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { useMemo } from 'react';
import { useTheme } from '../../shared/theme/ThemeProvider';

/** Native iOS stack headers: large titles on the first screen of each tab, themed colours. */
export function useStackScreenOptions(): NativeStackNavigationOptions {
  const theme = useTheme();
  return useMemo(
    () => ({
      headerLargeTitle: true,
      headerShadowVisible: false,
      headerLargeTitleShadowVisible: false,
      headerStyle: { backgroundColor: theme.colors.background },
      headerTintColor: theme.colors.accent,
      headerTitleStyle: { color: theme.colors.textPrimary },
      headerLargeTitleStyle: { color: theme.colors.textPrimary },
      contentStyle: { backgroundColor: theme.colors.background },
    }),
    [theme],
  );
}
