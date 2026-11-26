import { useQueryClient } from '@tanstack/react-query';
import { REALTIME_PATH } from '@tw/contracts';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { io, type Socket } from 'socket.io-client';
import { API_URL } from '../api/http';
import { sessionController, useSessionStore } from '../auth/session';
import { invalidationsFor, REALTIME_EVENTS } from './realtime';

/** Server-side rejections that a token refresh fixes (expired) vs. ones it cannot. */
const REFRESHABLE = new Set(['TOKEN_EXPIRED', 'UNAUTHENTICATED']);
const MAX_REFRESH_ATTEMPTS = 3;

function originOf(url: string): string {
  const match = /^(https?:\/\/[^/]+)/i.exec(url);
  return match?.[1] ?? url;
}

/**
 * Keeps one Socket.IO connection while signed in and the app is in the foreground, and turns
 * events into query invalidations. On (re)connect after a gap everything is refetched, since
 * events sent while offline are not replayed. Screens also refresh on focus, so a missing
 * socket only makes updates less immediate, never wrong.
 */
export function useRealtime(): void {
  const queryClient = useQueryClient();
  const userId = useSessionStore((s) => (s.status === 'signedIn' ? (s.user?.id ?? null) : null));

  useEffect(() => {
    if (!userId) return;
    const socket: Socket = io(originOf(API_URL), {
      path: REALTIME_PATH,
      transports: ['websocket'],
      autoConnect: false,
      reconnectionDelayMax: 30_000,
      // Read the token at every (re)connect, so a refreshed token is used.
      auth: (cb) => cb({ token: useSessionStore.getState().accessToken ?? '' }),
    });
    let hadConnection = false;
    let stopped = false;
    /** Consecutive refresh-and-retry attempts without a successful connection. */
    let refreshAttempts = 0;

    for (const event of REALTIME_EVENTS) {
      socket.on(event, (data: unknown) => {
        const keys = invalidationsFor(event, data as never, userId);
        for (const queryKey of keys) {
          void queryClient.invalidateQueries({ queryKey });
        }
      });
    }
    socket.on('connect', () => {
      if (hadConnection) void queryClient.invalidateQueries();
      hadConnection = true;
      refreshAttempts = 0;
    });
    const reconnectWithFreshToken = () => {
      if (refreshAttempts >= MAX_REFRESH_ATTEMPTS) return; // until the next foreground
      refreshAttempts += 1;
      sessionController
        .refresh()
        .then((ok) => {
          if (ok && !stopped && AppState.currentState !== 'background') socket.connect();
        })
        .catch(() => undefined); // offline: the next foreground tries again
    };
    socket.on('connect_error', (error: Error & { data?: { code?: string } }) => {
      // Middleware rejections are not retried by Socket.IO itself.
      if (REFRESHABLE.has(error.data?.code ?? '')) reconnectWithFreshToken();
    });
    socket.on('disconnect', (reason) => {
      // The server closes the socket when the access token expires.
      if (reason === 'io server disconnect') reconnectWithFreshToken();
    });

    if (AppState.currentState !== 'background') socket.connect();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        refreshAttempts = 0;
        socket.connect();
      } else socket.disconnect();
    });

    return () => {
      stopped = true;
      subscription.remove();
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [userId, queryClient]);
}
