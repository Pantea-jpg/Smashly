import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AdminUserDetail } from '@tw/contracts';
import * as SecureStore from 'expo-secure-store';
import { mockApi, type MockRequest, ok, profile, session, user } from '../../../../test/api';
import { App } from '../../../app/App';
import { resetSessionStoreForTests } from '../../../shared/auth/session';
import { useViewAsStore } from '../../../shared/auth/viewAs';
import { usePreferencesStore } from '../../../stores/preferences.store';

const keychain = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const ANNA_ID = '0192f6d2-7a3c-7b1e-9f00-00000000a001';
const VIEW_ID = '0192f6d2-7a3c-7b1e-9f00-00000000f001';

function anna(overrides: Partial<AdminUserDetail> = {}): AdminUserDetail {
  return {
    id: ANNA_ID,
    email: 'anna@example.test',
    firstName: 'Anna',
    lastName: 'de Vries',
    avatarUrl: null,
    role: 'USER',
    status: 'ACTIVE',
    emailVerified: true,
    balance: { amountMinor: 2500, currency: 'EUR' },
    debt: { amountMinor: 0, currency: 'EUR' },
    createdAt: '2026-01-15T10:00:00.000Z',
    lastLoginAt: null,
    phone: null,
    preferredLanguage: 'nl',
    deletedAt: null,
    ...overrides,
  };
}

function page(items: AdminUserDetail[]) {
  return {
    status: 200,
    body: {
      data: items,
      meta: { requestId: 't', page: { page: 1, pageSize: 25, total: items.length } },
    },
  };
}

function adminRoutes(
  extra: Record<string, (r: MockRequest) => { status: number; body?: unknown }> = {},
) {
  return {
    'POST /auth/login': () => ok(session({ role: 'ADMIN', firstName: 'Ada', lastName: 'Admin' })),
    'GET /admin/users': () => page([anna()]),
    [`GET /admin/users/${ANNA_ID}`]: () => ok(anna()),
    ...extra,
  };
}

async function openUsers() {
  await render(<App />);
  await fireEvent.changeText(await screen.findByTestId('field-email'), 'ada@example.test');
  await fireEvent.changeText(screen.getByTestId('field-password'), 'correct horse battery');
  await fireEvent.press(screen.getByTestId('login-submit'));
  await fireEvent.press((await screen.findAllByText('Users'))[0]!);
  await screen.findByTestId('users-list');
}

beforeEach(() => {
  keychain.clear();
  resetSessionStoreForTests();
  useViewAsStore.setState({ session: null });
  usePreferencesStore.setState({ language: 'en', appearance: 'system' });
});

describe('admin users', () => {
  it('lists users with total and balance, and searches by name', async () => {
    const requests = mockApi(adminRoutes());
    await openUsers();
    expect(await screen.findByText('Anna de Vries')).toBeTruthy();
    expect(screen.getByText('1 user')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('users-search'), 'anna');
    await waitFor(() =>
      expect(
        requests.some((r) => r.path.startsWith('/admin/users?') && r.path.includes('q=anna')),
      ).toBe(true),
    );
  });

  it('filters by status', async () => {
    const requests = mockApi(adminRoutes());
    await openUsers();
    await fireEvent.press(screen.getByTestId('users-filter-PENDING_APPROVAL'));
    await waitFor(() =>
      expect(requests.some((r) => r.path.includes('status=PENDING_APPROVAL'))).toBe(true),
    );
  });

  it('deactivates a user with a required reason', async () => {
    const requests = mockApi(
      adminRoutes({
        [`PATCH /admin/users/${ANNA_ID}/status`]: () => ok(anna({ status: 'INACTIVE' })),
      }),
    );
    await openUsers();
    await fireEvent.press(await screen.findByTestId('user-row-anna@example.test'));
    await fireEvent.press(await screen.findByTestId('deactivate-user'));

    await fireEvent.press(await screen.findByTestId('confirm-status'));
    expect(await screen.findByText('This field is required')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('field-reason'), 'Membership ended');
    await fireEvent.press(screen.getByTestId('confirm-status'));
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({
        status: 'INACTIVE',
        reason: 'Membership ended',
      }),
    );
  });
});

describe('View as User', () => {
  it('shows the user app read-only under a banner, sends the header, and exits cleanly', async () => {
    const requests = mockApi(
      adminRoutes({
        'POST /admin/view-sessions': () =>
          ok(
            {
              id: VIEW_ID,
              expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
              subject: user({ id: ANNA_ID }),
            },
            201,
          ),
        'GET /me/profile': () => ok(profile({ id: ANNA_ID, phone: '+31612345678' })),
        [`DELETE /admin/view-sessions/${VIEW_ID}`]: () => ({ status: 204 }),
      }),
    );
    await openUsers();
    await fireEvent.press(await screen.findByTestId('user-row-anna@example.test'));
    await fireEvent.press(await screen.findByTestId('view-as-user'));

    // The member app, with a persistent read-only banner.
    expect(await screen.findByText('Viewing as Anna de Vries · Read-only')).toBeTruthy();
    expect(screen.getAllByText('Wallet').length).toBeGreaterThan(0);

    await fireEvent.press(screen.getAllByText('Profile')[0]!);
    expect(await screen.findByText('+31612345678')).toBeTruthy();
    // No way to change anything.
    expect(screen.queryByTestId('row-edit-profile')).toBeNull();
    expect(screen.queryByTestId('change-avatar')).toBeNull();
    expect(screen.queryByTestId('sign-out')).toBeNull();

    const profileRequest = requests.find((r) => r.path === '/me/profile');
    expect(profileRequest?.headers['x-view-session']).toBe(VIEW_ID);

    await fireEvent.press(screen.getByTestId('exit-view-as'));
    expect(await screen.findAllByText('Finance')).not.toHaveLength(0);
    const exit = requests.find((r) => r.method === 'DELETE');
    expect(exit?.path).toBe(`/admin/view-sessions/${VIEW_ID}`);
    expect(exit?.headers['x-view-session']).toBeUndefined();
    expect(useViewAsStore.getState().session).toBeNull();
  });
});
