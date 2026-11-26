import { DeviceSchema } from '@tw/contracts';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { sessionController } from '../auth/session';

export type PushPermission = 'granted' | 'denied' | 'undetermined';

/** Show pushes as banners while the app is open too (the in-app list updates via the socket). */
Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
});

/** The token this phone registered with the API in this app session (for sign-out). */
let registeredToken: string | null = null;

function toPermission(status: string): PushPermission {
  return status === 'granted' ? 'granted' : status === 'denied' ? 'denied' : 'undetermined';
}

export async function getPushPermission(): Promise<PushPermission> {
  const { status } = await Notifications.getPermissionsAsync();
  return toPermission(status);
}

/**
 * Sends this phone's native APNs token to the API (POST /me/devices). Called after sign-in,
 * on every launch (keeps the token fresh server-side) and when iOS rotates the token.
 * Does nothing without permission or outside iOS.
 */
export async function registerForPush(token?: string): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  if ((await getPushPermission()) !== 'granted') return false;
  const deviceToken: unknown = token ?? (await Notifications.getDevicePushTokenAsync()).data;
  if (typeof deviceToken !== 'string' || deviceToken.length === 0) return false;
  await sessionController.request({
    method: 'POST',
    path: '/me/devices',
    body: {
      token: deviceToken,
      platform: 'IOS',
      provider: 'APNS',
      ...(Constants.expoConfig?.version ? { appVersion: Constants.expoConfig.version } : {}),
    },
    schema: DeviceSchema,
    ignoreViewAs: true, // registration is always for the signed-in account
  });
  registeredToken = deviceToken;
  return true;
}

/** Asks iOS for permission (the system dialog appears once), then registers. */
export async function requestPushPermission(): Promise<PushPermission> {
  const { status } = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });
  const permission = toPermission(status);
  if (permission === 'granted') await registerForPush().catch(() => false);
  return permission;
}

/** Before sign-out: stop pushes to this phone and clear the app icon badge. */
export async function unregisterFromPush(): Promise<void> {
  const token = registeredToken;
  registeredToken = null;
  await Notifications.setBadgeCountAsync(0).catch(() => false);
  if (!token) return;
  await sessionController
    .request({ method: 'DELETE', path: `/me/devices/${token}`, ignoreViewAs: true })
    .catch(() => undefined);
}

sessionController.onBeforeLogout(unregisterFromPush);

/** Test helper. */
export function resetPushStateForTests(): void {
  registeredToken = null;
}

/** Where a tapped push should take the user (from the ids the server put in the payload). */
export type PushRoute =
  | { kind: 'training'; trainingId: string }
  | { kind: 'transaction'; transactionId: string }
  | { kind: 'payment' }
  | { kind: 'finalize'; trainingId: string | null }
  | { kind: 'inbox' };

export function routeForPush(data: Record<string, unknown> | undefined | null): PushRoute {
  const get = (k: string) => {
    const value = data?.[k];
    return typeof value === 'string' ? value : null;
  };
  const type = get('type');
  const trainingId = get('trainingId');
  const transactionId = get('transactionId');
  if (type === 'ATTENDANCE_FINALIZATION_REMINDER') return { kind: 'finalize', trainingId };
  if (transactionId) return { kind: 'transaction', transactionId };
  if (trainingId) return { kind: 'training', trainingId };
  if (get('paymentId')) return { kind: 'payment' };
  return { kind: 'inbox' };
}
