import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import { AppText } from './AppText';

/** Full-screen form layout: large title, keyboard-aware scrolling, generous whitespace. */
export function FormScreen({
  title,
  subtitle,
  children,
  testID,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <SafeAreaView
      style={[styles.flex, { backgroundColor: theme.colors.background }]}
      testID={testID}
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            padding: theme.spacing.xl,
            paddingTop: theme.spacing.xxxl,
            gap: theme.spacing.lg,
          }}
        >
          <View style={{ gap: theme.spacing.xs, marginBottom: theme.spacing.md }}>
            <AppText variant="largeTitle" accessibilityRole="header">
              {title}
            </AppText>
            {subtitle ? <AppText tone="textSecondary">{subtitle}</AppText> : null}
          </View>
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** Translated error banner for a failed request. */
export function FormError({ message }: { message: string | null }) {
  const theme = useTheme();
  if (!message) return null;
  return (
    <View
      accessibilityRole="alert"
      style={{
        backgroundColor: theme.colors.surface,
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.danger,
        borderRadius: theme.radii.sm,
        padding: theme.spacing.md,
      }}
    >
      <AppText variant="subhead" tone="danger">
        {message}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
