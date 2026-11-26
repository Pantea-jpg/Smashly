import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useEffect, useEffectEvent, useRef } from 'react';
import { useSessionStore } from '../auth/session';
import { useViewAsSession } from '../auth/viewAs';
import {
  getPushPermission,
  type PushPermission,
  type PushRoute,
  registerForPush,
  requestPushPermission,
  routeForPush,
} from './push';

const PERMISSION_KEY = ['push-permission'] as const;

/** iOS notification permission for this app; re-read when the app returns to the foreground. */
export function usePushPermission() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: PERMISSION_KEY,
    queryFn: getPushPermission,
    staleTime: 0,
  });
  const request = useMutation({
    mutationFn: requestPushPermission,
    onSuccess: (status) => queryClient.setQueryData<PushPermission>(PERMISSION_KEY, status),
  });
  return { status: query.data ?? null, request };
}

/**
 * Signed-in shell: registers the device token (each launch, and when iOS rotates it), refreshes
 * the inbox when a push arrives in the foreground, and opens the screen a tapped push points to.
 * Not in View-as mode: pushes belong to the signed-in admin, not the viewed member.
 */
export function usePushLifecycle(onOpen: (route: PushRoute) => void): void {
  const queryClient = useQueryClient();
  const userId = useSessionStore((s) => (s.status === 'signedIn' ? (s.user?.id ?? null) : null));
  const viewing = useViewAsSession() !== null;
  const response = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    void registerForPush().catch(() => false); // offline or no permission: next launch
    const tokens = Notifications.addPushTokenListener((token) => {
      if (typeof token.data === 'string') void registerForPush(token.data).catch(() => false);
    });
    const received = Notifications.addNotificationReceivedListener(() => {
      void queryClient.invalidateQueries({ queryKey: ['subject', userId, 'notifications'] });
    });
    return () => {
      tokens.remove();
      received.remove();
    };
  }, [userId, queryClient]);

  const open = useEffectEvent((route: PushRoute) => onOpen(route));
  useEffect(() => {
    if (!response || viewing) return;
    const id = response.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    open(routeForPush(response.notification.request.content.data));
  }, [response, viewing]);
}

/** Keeps the app icon badge equal to the member's unread notifications. */
export function useBadgeCount(unread: number | undefined): void {
  useEffect(() => {
    if (unread === undefined) return;
    void Notifications.setBadgeCountAsync(unread).catch(() => false);
  }, [unread]);
}
