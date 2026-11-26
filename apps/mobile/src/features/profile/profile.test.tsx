import { fireEvent, render, screen } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { Alert } from 'react-native';
import { mockApi, ok, profile, session } from '../../../test/api';
import { App } from '../../app/App';
import { resetSessionStoreForTests } from '../../shared/auth/session';
import { usePreferencesStore } from '../../stores/preferences.store';

const keychain = (SecureStore as unknown as { __store: Map<string, string> }).__store;

async function openProfile() {
  await render(<App />);
  await fireEvent.changeText(await screen.findByTestId('field-email'), 'anna@example.test');
  await fireEvent.changeText(screen.getByTestId('field-password'), 'correct horse battery');
  await fireEvent.press(screen.getByTestId('login-submit'));
  await fireEvent.press((await screen.findAllByText('Profile'))[0]!);
  await screen.findByTestId('profile-screen');
}

beforeEach(() => {
  keychain.clear();
  resetSessionStoreForTests();
  usePreferencesStore.setState({ language: 'en', appearance: 'system' });
});

describe('profile screen', () => {
  it('shows the profile with name, email and member-since date', async () => {
    mockApi({ 'POST /auth/login': () => ok(session()), 'GET /me/profile': () => ok(profile()) });
    await openProfile();
    expect(screen.getByText('Anna de Vries')).toBeTruthy();
    expect(screen.getByText('anna@example.test')).toBeTruthy();
    expect(screen.getByText('Member since 15 January 2026')).toBeTruthy();
    expect(screen.getByText('AD')).toBeTruthy(); // initials when there is no photo
  });

  it('edits the profile; an empty phone is sent as null', async () => {
    const requests = mockApi({
      'POST /auth/login': () => ok(session()),
      'GET /me/profile': () => ok(profile({ phone: '+31612345678' })),
      'PATCH /me/profile': () => ok(profile({ firstName: 'Annie', phone: null })),
    });
    await openProfile();
    await fireEvent.press(screen.getByTestId('row-edit-profile'));
    await fireEvent.changeText(await screen.findByTestId('field-firstName'), 'Annie');
    await fireEvent.changeText(screen.getByTestId('field-phone'), '');
    await fireEvent.press(screen.getByTestId('save-profile'));

    expect(await screen.findByText('Annie de Vries')).toBeTruthy();
    expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({
      firstName: 'Annie',
      lastName: 'de Vries',
      phone: null,
    });
  });

  it('toggles a push notification category', async () => {
    const requests = mockApi({
      'POST /auth/login': () => ok(session()),
      'GET /me/profile': () => ok(profile()),
      'GET /me/notification-preferences': () =>
        ok([
          { category: 'TRAININGS', pushEnabled: true },
          { category: 'PAYMENTS', pushEnabled: true },
          { category: 'REMINDERS', pushEnabled: true },
        ]),
      'PUT /me/notification-preferences': () =>
        ok([
          { category: 'TRAININGS', pushEnabled: true },
          { category: 'PAYMENTS', pushEnabled: true },
          { category: 'REMINDERS', pushEnabled: false },
        ]),
    });
    await openProfile();
    await fireEvent.press(screen.getByTestId('row-notifications'));
    await fireEvent(await screen.findByTestId('toggle-REMINDERS'), 'valueChange', false);

    expect(requests.find((r) => r.method === 'PUT')?.body).toEqual([
      { category: 'REMINDERS', pushEnabled: false },
    ]);
  });

  it('changes the password and continues with the fresh session', async () => {
    const fresh = session();
    mockApi({
      'POST /auth/login': () => ok(session()),
      'GET /me/profile': () => ok(profile()),
      'PATCH /me/password': () => ok(fresh),
    });
    await openProfile();
    await fireEvent.press(screen.getByTestId('row-change-password'));
    await fireEvent.changeText(
      await screen.findByTestId('field-currentPassword'),
      'correct horse battery',
    );
    await fireEvent.changeText(screen.getByTestId('field-newPassword'), 'a brand new passphrase');
    await fireEvent.press(screen.getByTestId('submit-password'));

    expect(
      await screen.findByText('Password changed. Your other devices have been signed out.'),
    ).toBeTruthy();
    expect([...keychain.values()][0]).toBe(fresh.tokens.refreshToken);
  });

  it('deletes the account after confirmation and signs out', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    const requests = mockApi({
      'POST /auth/login': () => ok(session()),
      'GET /me/profile': () => ok(profile()),
      'DELETE /me': () => ({ status: 204 }),
    });
    await openProfile();
    await fireEvent.press(screen.getByTestId('row-delete-account'));
    await fireEvent.changeText(
      await screen.findByTestId('field-password'),
      'correct horse battery',
    );
    await fireEvent.press(screen.getByTestId('delete-account-submit'));

    expect(await screen.findByTestId('login-screen')).toBeTruthy();
    expect(requests.find((r) => r.method === 'DELETE')?.body).toEqual({
      password: 'correct horse battery',
    });
    expect(keychain.size).toBe(0);
  });
});
