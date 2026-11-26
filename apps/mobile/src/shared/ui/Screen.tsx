import type { ReactNode } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';

/** Standard scrollable screen body with themed background and consistent padding. */
export function Screen({ children, testID }: { children: ReactNode; testID?: string }) {
  const theme = useTheme();
  return (
    <ScrollView
      testID={testID}
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={[styles.content, { padding: theme.spacing.lg, gap: theme.spacing.lg }]}
      contentInsetAdjustmentBehavior="automatic"
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1 },
});
