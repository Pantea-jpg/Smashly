import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Animated, View } from 'react-native';
import { useErrorMessage } from '../i18n/useErrorMessage';
import { useTheme } from '../theme/ThemeProvider';
import { AppText } from './AppText';
import { Button } from './Button';

/** Grey placeholder blocks shown while a screen's first data loads (no layout jump). */
export function Skeleton({ rows = 3, testID = 'skeleton' }: { rows?: number; testID?: string }) {
  const theme = useTheme();
  const [opacity] = useState(() => new Animated.Value(0.5));
  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    let unmounted = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      // The check is async: never start the loop after the skeleton is gone.
      if (reduce || unmounted) return;
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.5, duration: 700, useNativeDriver: true }),
        ]),
      );
      loop.start();
    });
    return () => {
      unmounted = true;
      loop?.stop();
    };
  }, [opacity]);
  return (
    <View testID={testID} accessibilityLabel="loading" accessible style={{ gap: theme.spacing.md }}>
      {Array.from({ length: rows }, (_, i) => (
        <Animated.View
          key={i}
          style={{
            opacity,
            height: i === 0 ? 96 : 56,
            borderRadius: theme.radii.md,
            backgroundColor: theme.colors.surfaceElevated,
          }}
        />
      ))}
    </View>
  );
}

export function EmptyState({
  message,
  icon = 'file-tray-outline',
}: {
  message: string;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const theme = useTheme();
  return (
    <View
      testID="empty-state"
      style={{ alignItems: 'center', gap: theme.spacing.sm, paddingVertical: theme.spacing.xxl }}
    >
      <Ionicons name={icon} size={36} color={theme.colors.textSecondary} />
      <AppText tone="textSecondary" style={{ textAlign: 'center' }}>
        {message}
      </AppText>
    </View>
  );
}

/** A failed request: translated message plus "Try again". */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const theme = useTheme();
  const errorMessage = useErrorMessage();
  const { t } = useTranslation('common');
  return (
    <View
      testID="error-state"
      style={{ alignItems: 'center', gap: theme.spacing.md, paddingVertical: theme.spacing.xl }}
    >
      <Ionicons name="cloud-offline-outline" size={36} color={theme.colors.textSecondary} />
      <AppText tone="textSecondary" style={{ textAlign: 'center' }}>
        {errorMessage(error)}
      </AppText>
      <Button testID="retry" variant="secondary" label={t('actions.retry')} onPress={onRetry} />
    </View>
  );
}

/** A coloured notice (debt, warnings, success). */
export function Banner({
  tone,
  message,
  testID,
}: {
  tone: 'warning' | 'danger' | 'success' | 'accent';
  message: string;
  testID?: string;
}) {
  const theme = useTheme();
  const icon =
    tone === 'success'
      ? 'checkmark-circle'
      : tone === 'accent'
        ? 'information-circle'
        : 'alert-circle';
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      style={{
        flexDirection: 'row',
        gap: theme.spacing.sm,
        alignItems: 'flex-start',
        padding: theme.spacing.md,
        borderRadius: theme.radii.sm,
        borderWidth: 1,
        borderColor: theme.colors[tone],
        backgroundColor: theme.colors.surface,
      }}
    >
      <Ionicons name={icon} size={20} color={theme.colors[tone]} />
      <AppText variant="subhead" style={{ flex: 1 }}>
        {message}
      </AppText>
    </View>
  );
}

/** Small rounded label (status of a training, a reservation, a transaction). */
export function Chip({
  label,
  tone = 'textSecondary',
  testID,
}: {
  label: string;
  tone?: 'textSecondary' | 'accent' | 'success' | 'warning' | 'danger';
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={{
        alignSelf: 'flex-start',
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: theme.spacing.xxs,
        borderRadius: theme.radii.pill,
        borderWidth: 1,
        borderColor: theme.colors[tone],
      }}
    >
      <AppText variant="caption" style={{ color: theme.colors[tone], fontWeight: '600' }}>
        {label}
      </AppText>
    </View>
  );
}
