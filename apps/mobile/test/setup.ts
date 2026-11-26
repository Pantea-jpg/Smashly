/* eslint-disable @typescript-eslint/no-require-imports */
// Jest setup: replace native modules with in-memory fakes.

jest.mock(
  '@react-native-async-storage/async-storage',
  () => require('@react-native-async-storage/async-storage/jest/async-storage-mock') as unknown,
);

// Provides fixed insets synchronously (the real provider waits for native measurement).
jest.mock(
  'react-native-safe-area-context',
  () => (require('react-native-safe-area-context/jest/mock') as { default: unknown }).default,
);

// Sentry's native module does not exist under Jest.
jest.mock('@sentry/react-native', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// Device language defaults to English in tests; individual tests can override getLocales.
jest.mock('expo-localization', () => ({
  getLocales: jest.fn(() => [{ languageTag: 'en-US', languageCode: 'en' }]),
}));

// In-memory Keychain.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    getItemAsync: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    setItemAsync: jest.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    __store: store,
  };
});

// Native haptics: no-ops.
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(() => Promise.resolve()),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

// Stripe PaymentSheet: tests set the outcome through presentPaymentSheet's mock.
jest.mock('@stripe/stripe-react-native', () => ({
  initStripe: jest.fn(() => Promise.resolve()),
  initPaymentSheet: jest.fn(() => Promise.resolve({})),
  presentPaymentSheet: jest.fn(() => Promise.resolve({})),
  handleURLCallback: jest.fn(() => Promise.resolve(false)),
  PaymentSheetError: { Canceled: 'Canceled', Failed: 'Failed', Timeout: 'Timeout' },
}));

// Push notifications: permission and token are controlled per test through these mocks.
jest.mock('expo-notifications', () => {
  const listeners = {
    response: null as unknown,
    token: [] as unknown[],
    received: [] as unknown[],
  };
  const subscription = { remove: jest.fn() };
  return {
    DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
    setNotificationHandler: jest.fn(),
    getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'undetermined' })),
    requestPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
    getDevicePushTokenAsync: jest.fn(() => Promise.resolve({ type: 'ios', data: 'ab'.repeat(32) })),
    setBadgeCountAsync: jest.fn(() => Promise.resolve(true)),
    addPushTokenListener: jest.fn(() => subscription),
    addNotificationReceivedListener: jest.fn(() => subscription),
    useLastNotificationResponse: jest.fn(() => listeners.response),
    __listeners: listeners,
  };
});

// Realtime: a fake socket that records handlers so tests can emit server events.
jest.mock('socket.io-client', () => {
  const sockets: unknown[] = [];
  return {
    io: jest.fn(() => {
      type MockHandler = (...args: unknown[]) => void;
      const handlers = new Map<string, MockHandler[]>();
      const socket: Record<string, unknown> = {
        handlers,
        on: jest.fn((event: string, fn: MockHandler): unknown => {
          handlers.set(event, [...(handlers.get(event) ?? []), fn]);
          return socket;
        }),
        connect: jest.fn((): unknown => socket),
        disconnect: jest.fn((): unknown => socket),
        removeAllListeners: jest.fn((): unknown => {
          handlers.clear();
          return socket;
        }),
        /** Test helper: deliver a server event. */
        serverEmit: (event: string, ...args: unknown[]) => {
          for (const fn of handlers.get(event) ?? []) fn(...args);
        },
      };
      sockets.push(socket);
      return socket;
    }),
    __sockets: sockets,
  };
});
