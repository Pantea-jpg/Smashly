import { useNavigation } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { useEffect, useEffectEvent } from 'react';
import { Alert } from 'react-native';

/** Light haptic confirmation after something important succeeded (payment, reservation). */
export function hapticSuccess(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
}

export function hapticWarning(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
}

/** Native confirmation dialog; resolves true when the confirming button is pressed. */
export function confirm(input: {
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(input.title, input.message, [
      { text: input.cancelLabel, style: 'cancel', onPress: () => resolve(false) },
      {
        text: input.confirmLabel,
        style: input.destructive ? 'destructive' : 'default',
        onPress: () => resolve(true),
      },
    ]);
  });
}

/**
 * Refetches when the screen regains focus (not on first mount). Until realtime events arrive
 * (Phase 8), this keeps balances and lists current when moving between tabs.
 */
export function useRefreshOnFocus(refetch: () => unknown): void {
  const navigation = useNavigation();
  // An effect event always sees the latest refetch, so callers may pass a new function on
  // every render without re-subscribing (or refetching) each time.
  const onFocusAgain = useEffectEvent(() => void refetch());
  useEffect(() => {
    let first = true; // 'focus' also fires when the screen first appears: skip that one.
    return navigation.addListener('focus', () => {
      if (first) {
        first = false;
        return;
      }
      onFocusAgain();
    });
  }, [navigation]);
}
