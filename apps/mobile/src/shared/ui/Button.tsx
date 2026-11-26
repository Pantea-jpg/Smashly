import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText } from './AppText';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'link' | 'destructive';
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  testID,
}: ButtonProps) {
  const theme = useTheme();
  const inactive = disabled || loading;

  if (variant === 'link') {
    return (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityState={{ disabled: inactive }}
        onPress={onPress}
        disabled={inactive}
        hitSlop={8}
        style={styles.link}
      >
        <AppText variant="subhead" tone="accent">
          {label}
        </AppText>
      </Pressable>
    );
  }

  const background =
    variant === 'primary'
      ? theme.colors.accent
      : variant === 'destructive'
        ? theme.colors.danger
        : theme.colors.surface;
  const tone = variant === 'secondary' ? 'accent' : 'textOnAccent';

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          borderRadius: theme.radii.md,
          opacity: inactive ? 0.6 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={theme.colors[tone]} />
      ) : (
        <AppText variant="headline" tone={tone}>
          {label}
        </AppText>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 50, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
