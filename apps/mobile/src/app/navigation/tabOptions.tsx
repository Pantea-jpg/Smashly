import Ionicons from '@expo/vector-icons/Ionicons';
import type { BottomTabNavigationOptions } from '@react-navigation/bottom-tabs';
import type { ComponentProps } from 'react';
import { useMemo } from 'react';
import { useTheme } from '../../shared/theme/ThemeProvider';

export type IconName = ComponentProps<typeof Ionicons>['name'];

/** Outline icon when idle, filled when selected (iOS convention). */
export function tabIcon(name: IconName): NonNullable<BottomTabNavigationOptions['tabBarIcon']> {
  return ({ color, size, focused }) => (
    <Ionicons
      name={(focused ? name.replace('-outline', '') : name) as IconName}
      size={size}
      color={color}
    />
  );
}

/** Shared tab bar styling. Tabs that host a native stack hide the tab header. */
export function useTabScreenOptions(): BottomTabNavigationOptions {
  const theme = useTheme();
  return useMemo(
    () => ({
      headerShadowVisible: false,
      headerStyle: { backgroundColor: theme.colors.background },
      headerTitleStyle: { color: theme.colors.textPrimary },
      tabBarActiveTintColor: theme.colors.accent,
      tabBarInactiveTintColor: theme.colors.textSecondary,
      tabBarStyle: {
        backgroundColor: theme.colors.surface,
        borderTopColor: theme.colors.separator,
      },
      tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
    }),
    [theme],
  );
}
