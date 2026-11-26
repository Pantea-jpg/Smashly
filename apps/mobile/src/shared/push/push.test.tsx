import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { MeTraining } from '@tw/contracts';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { io } from 'socket.io-client';
import { mockApi, type MockRequest, type MockResponse, ok, session } from '../../../test/api';
import { cursorPage, meTraining, transaction, wallet } from '../../../test/money';
import { App } from '../../app/App';
import { pushDestination } from '../../app/navigation/RootNavigator';
import { usePreferencesStore } from '../../stores/preferences.store';
import { resetSessionStoreForTests, sessionController } from '../auth/session';
import { useViewAsStore } from '../auth/viewAs';
import { invalidationsFor } from '../realtime/realtime';
import { resetPushStateForTests, routeForPush } from './push';

const keychain = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const TOKEN = 'ab'.repeat(32);
jest.setTimeout(20_000);
type Routes = Record<string, (r: MockRequest) => MockResponse | Promise<MockResponse>>;

interface FakeSocket {
  serverEmit: (event: string, ...args: unknown[]) => void;
  connect: jest.Mock;
  disconnect: jest.Mock;
}
const lastSocket = () => jest.mocked(io).mock.results.at(-1)?.value as FakeSocket;

function routes(training: MeTraining = meTraining(), extra: Routes = {}): Routes {
  return {
    'POST /auth/login': () => ok(session()),
    'POST /auth/logout': () => ({ status: 204 }),
    'GET /me/wallet': () => ok(wallet()),
    'GET /me/trainings': () => cursorPage([training]),
    [`GET /me/trainings/${training.id}`]: () => ok(training),
    'GET /me/transactions': () => cursorPage([transaction()]),
    'GET /me/debts': () => ok([]),
    'GET /me/notifications/unread-count': () => ok({ unread: 3 }),
    'GET /me/notifications': () => cursorPage([]),
    'POST /me/devices': () =>
      ok({
        id: '0193a000-0000-7000-8000-0000000000d1',
        platform: 'IOS',
        provider: 'APNS',
        appVersion: '0.1.0',
        lastSeenAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }),
    [`DELETE /me/devices/${TOKEN}`]: () => ({ status: 204 }),
    ...extra,
  };
}

async function signIn({ waitForHome = true } = {}) {
  await render(<App />);
  await fireEvent.changeText(await screen.findByTestId('field-email'), 'anna@example.test');
  await fireEvent.changeText(screen.getByTestId('field-password'), 'correct horse battery');
  await fireEvent.press(screen.getByTestId('login-submit'));
  if (waitForHome) await screen.findByTestId('home-screen');
}

const permission = (status: 'granted' | 'denied' | 'undetermined') =>
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status } as never);

beforeEach(() => {
  keychain.clear();
  resetSessionStoreForTests();
  resetPushStateForTests();
  useViewAsStore.setState({ session: null });
  usePreferencesStore.setState({
    language: 'en',
    appearance: 'system',
    pushPromptDismissed: false,
  });
  jest.mocked(Notifications.useLastNotificationResponse).mockReturnValue(null);
  permission('undetermined');
});

describe('push registration', () => {
  it('registers the native APNs token after sign-in when notifications are allowed', async () => {
    permission('granted');
    const received = mockApi(routes());
    await signIn();
    await waitFor(() => expect(received.some((r) => r.path === '/me/devices')).toBe(true));
    expect(received.find((r) => r.path === '/me/devices')?.body).toMatchObject({
      token: TOKEN,
      platform: 'IOS',
      provider: 'APNS',
    });
    expect(screen.queryByTestId('push-prompt')).toBeNull();
  });

  it('asks for permission from the Home card, then registers', async () => {
    const received = mockApi(routes());
    await signIn();
    expect(received.some((r) => r.path === '/me/devices')).toBe(false);
    permission('granted'); // what iOS reports after the member taps Allow
    await fireEvent.press(await screen.findByTestId('push-prompt-enable'));
    await waitFor(() => expect(received.some((r) => r.path === '/me/devices')).toBe(true));
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('push-prompt')).toBeNull());
  });

  it('remembers "Not now"', async () => {
    mockApi(routes());
    await signIn();
    await fireEvent.press(await screen.findByTestId('push-prompt-dismiss'));
    expect(screen.queryByTestId('push-prompt')).toBeNull();
    expect(usePreferencesStore.getState().pushPromptDismissed).toBe(true);
  });

  it('unregisters the phone before signing out', async () => {
    permission('granted');
    const received = mockApi(routes());
    await signIn();
    await waitFor(() => expect(received.some((r) => r.path === '/me/devices')).toBe(true));
    await act(() => sessionController.logout());
    const paths = received.map((r) => `${r.method} ${r.path}`);
    const unregister = paths.indexOf(`DELETE /me/devices/${TOKEN}`);
    expect(unregister).toBeGreaterThan(-1);
    expect(unregister).toBeLessThan(paths.indexOf('POST /auth/logout'));
    expect(Notifications.setBadgeCountAsync).toHaveBeenLastCalledWith(0);
  });

  it('keeps the app icon badge equal to the unread count', async () => {
    mockApi(routes());
    await signIn();
    await waitFor(() => expect(Notifications.setBadgeCountAsync).toHaveBeenCalledWith(3));
  });

  it('opens the training a tapped reminder is about', async () => {
    const training = meTraining({ title: 'Thursday club' });
    jest.mocked(Notifications.useLastNotificationResponse).mockReturnValue({
      actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
      notification: {
        request: {
          identifier: 'push-1',
          content: { data: { type: 'TRAINING_REMINDER', trainingId: training.id } },
        },
      },
    } as never);
    mockApi(routes(training));
    await signIn({ waitForHome: false });
    expect(await screen.findByTestId('training-detail')).toBeTruthy();
    expect(await screen.findByText('Thursday club')).toBeTruthy();
  });
});

describe('push routing', () => {
  it.each([
    [
      { type: 'TRAINING_REMINDER', trainingId: 't1' },
      { kind: 'training', trainingId: 't1' },
    ],
    [
      { type: 'TRAINING_CHARGED', trainingId: 't1', transactionId: 'x1' },
      { kind: 'transaction', transactionId: 'x1' },
    ],
    [{ type: 'TOP_UP_FAILED', paymentId: 'p1' }, { kind: 'payment' }],
    [
      { type: 'ATTENDANCE_FINALIZATION_REMINDER', trainingId: 't1' },
      { kind: 'finalize', trainingId: 't1' },
    ],
    [{ type: 'DEBT_REMINDER' }, { kind: 'inbox' }],
    [undefined, { kind: 'inbox' }],
  ] as const)('%o → %o', (data, expected) => {
    expect(routeForPush(data)).toEqual(expected);
  });

  it('sends admins to the attendance screen and members to the right tab', () => {
    expect(pushDestination({ kind: 'finalize', trainingId: 't1' }, 'ADMIN')).toEqual({
      screen: 'AdminTrainings',
      params: { screen: 'Attendance', params: { trainingId: 't1' }, initial: false },
    });
    expect(pushDestination({ kind: 'inbox' }, 'USER')).toEqual({ screen: 'Notifications' });
    expect(pushDestination({ kind: 'transaction', transactionId: 'x' }, 'USER')).toMatchObject({
      screen: 'Wallet',
      params: { screen: 'TransactionDetail', params: { transactionId: 'x' } },
    });
  });
});

describe('realtime', () => {
  it('maps events to the queries they make stale', () => {
    expect(invalidationsFor('wallet.updated', { userId: 'me' }, 'me')).toContainEqual([
      'subject',
      'me',
      'wallet',
    ]);
    expect(invalidationsFor('payment.updated', { paymentId: 'p1' }, 'me')).toEqual([
      ['subject', 'me', 'payment', 'p1'],
    ]);
    expect(invalidationsFor('training.updated', { trainingId: null }, 'me')).toContainEqual([
      'subject',
      'me',
      'training',
    ]);
    expect(invalidationsFor('admin.activity', { userId: 'u1' }, 'me')).toContainEqual([
      'admin',
      'user',
      'u1',
    ]);
  });

  it('connects after sign-in and refetches the wallet on wallet.updated', async () => {
    const received = mockApi(routes());
    await signIn();
    const socket = lastSocket();
    expect(socket.connect).toHaveBeenCalled();
    const walletCalls = () => received.filter((r) => r.path === '/me/wallet').length;
    await waitFor(() => expect(walletCalls()).toBeGreaterThan(0));
    const before = walletCalls();
    await act(() => socket.serverEmit('wallet.updated', { userId: 'me' }));
    await waitFor(() => expect(walletCalls()).toBeGreaterThan(before));
  });

  it('refreshes the token and reconnects when the server rejects an expired token', async () => {
    const received = mockApi(routes(meTraining(), { 'POST /auth/refresh': () => ok(session()) }));
    await signIn();
    const socket = lastSocket();
    const connects = socket.connect.mock.calls.length;
    await act(() =>
      socket.serverEmit(
        'connect_error',
        Object.assign(new Error('TOKEN_EXPIRED'), {
          data: { code: 'TOKEN_EXPIRED' },
        }),
      ),
    );
    await waitFor(() => expect(received.some((r) => r.path === '/auth/refresh')).toBe(true));
    await waitFor(() => expect(socket.connect.mock.calls.length).toBeGreaterThan(connects));
  });
});
