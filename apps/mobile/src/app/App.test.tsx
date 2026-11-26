import { fireEvent, render, screen } from '@testing-library/react-native';
import { money } from '@tw/money';
import * as SecureStore from 'expo-secure-store';
import { getLocales } from 'expo-localization';
import { Text } from 'react-native';
import { apiError, mockApi, ok, profile, session } from '../../test/api';
import { resetSessionStoreForTests } from '../shared/auth/session';
import { useFormatMoney } from '../shared/format/money';
import { usePreferencesStore } from '../stores/preferences.store';
import { App, AppProviders, createQueryClient } from './App';

const keychain = (SecureStore as unknown as { __store: Map<string, string> }).__store;

function deviceLanguage(tag: string) {
  jest
    .mocked(getLocales)
    .mockReturnValue([
      { languageTag: tag, languageCode: tag.slice(0, 2) } as ReturnType<typeof getLocales>[number],
    ]);
}

async function signIn(email = 'anna@example.test', password = 'correct horse battery') {
  await fireEvent.changeText(await screen.findByTestId('field-email'), email);
  await fireEvent.changeText(screen.getByTestId('field-password'), password);
  await fireEvent.press(screen.getByTestId('login-submit'));
}

beforeEach(() => {
  keychain.clear();
  resetSessionStoreForTests();
  usePreferencesStore.setState({ language: null, appearance: 'system' });
  deviceLanguage('en-US');
});

describe('authentication flow', () => {
  it('shows sign-in when there is no stored session, then the user tabs after login', async () => {
    const requests = mockApi({ 'POST /auth/login': () => ok(session()) });
    await render(<App />);

    expect(await screen.findByTestId('login-screen')).toBeTruthy();
    await signIn('  Anna@Example.TEST ');

    expect(await screen.findAllByText('Wallet')).not.toHaveLength(0);
    expect(screen.queryByText('Finance')).toBeNull();
    // Input is normalised by the shared contract before it is sent.
    expect(requests[0]?.body).toEqual({
      email: 'anna@example.test',
      password: 'correct horse battery',
    });
    expect([...keychain.values()][0]).toMatch(/^refresh-token-/);
  });

  it('shows the admin tabs for an admin', async () => {
    mockApi({ 'POST /auth/login': () => ok(session({ role: 'ADMIN' })) });
    await render(<App />);
    await signIn();
    expect(await screen.findAllByText('Finance')).not.toHaveLength(0);
    expect(screen.queryByText('Wallet')).toBeNull();
  });

  it('shows a translated error for wrong credentials', async () => {
    mockApi({ 'POST /auth/login': () => apiError(401, 'INVALID_CREDENTIALS') });
    await render(<App />);
    await signIn();
    expect(await screen.findByText('Incorrect email or password.')).toBeTruthy();
  });

  it('validates input on the device before calling the API', async () => {
    const requests = mockApi({});
    await render(<App />);
    await signIn('not-an-email', '');
    expect(await screen.findByText('Enter a valid email address')).toBeTruthy();
    expect(screen.getByText('This field is required')).toBeTruthy();
    expect(requests).toHaveLength(0);
  });

  it('restores the session on launch without asking to sign in', async () => {
    keychain.set('tw.refreshToken.v1', 'stored-refresh-token-xxxxxxxxxxxxxxxx');
    mockApi({ 'POST /auth/refresh': () => ok(session()) });
    await render(<App />);
    expect(await screen.findAllByText('Wallet')).not.toHaveLength(0);
    expect(screen.queryByTestId('login-screen')).toBeNull();
  });

  it('signs out from the profile screen and returns to sign-in', async () => {
    mockApi({
      'POST /auth/login': () => ok(session()),
      'GET /me/profile': () => ok(profile()),
      'POST /auth/logout': () => ({ status: 204 }),
    });
    await render(<App />);
    await signIn();
    await fireEvent.press((await screen.findAllByText('Profile'))[0]!);
    await fireEvent.press(await screen.findByTestId('sign-out'));
    expect(await screen.findByTestId('login-screen')).toBeTruthy();
    expect(keychain.size).toBe(0);
  });

  it('registers with the app language and enforces the password policy', async () => {
    deviceLanguage('nl-NL');
    const requests = mockApi({
      'POST /auth/register': () =>
        ok({ status: 'ACTIVE', ...session({ preferredLanguage: 'nl' }) }, 201),
    });
    await render(<App />);
    await fireEvent.press(await screen.findByTestId('go-register'));

    await fireEvent.changeText(await screen.findByTestId('field-firstName'), 'Anna');
    await fireEvent.changeText(screen.getByTestId('field-lastName'), 'de Vries');
    await fireEvent.changeText(screen.getByTestId('field-email'), 'anna@example.test');
    await fireEvent.changeText(screen.getByTestId('field-password'), 'short');
    await fireEvent.press(screen.getByTestId('register-submit'));
    expect(await screen.findByText('Gebruik minimaal 10 tekens')).toBeTruthy();
    expect(requests).toHaveLength(0);

    await fireEvent.changeText(screen.getByTestId('field-password'), 'a long enough passphrase');
    await fireEvent.press(screen.getByTestId('register-submit'));
    expect(await screen.findAllByText('Portemonnee')).not.toHaveLength(0);
    expect(requests[0]?.body).toMatchObject({
      preferredLanguage: 'nl',
      email: 'anna@example.test',
    });
    expect(requests[0]?.body).not.toHaveProperty('phone');
  });
});

describe('language', () => {
  it('detects Dutch from the device on first launch', async () => {
    deviceLanguage('nl-NL');
    mockApi({});
    await render(<App />);
    expect(await screen.findAllByText('Inloggen')).not.toHaveLength(0);
  });

  it('switches language in settings, keeps the choice and saves it to the profile', async () => {
    const requests = mockApi({
      'POST /auth/login': () => ok(session()),
      'GET /me/profile': () => ok(profile()),
      'PATCH /me/profile': () => ok(profile({ preferredLanguage: 'nl' })),
    });
    await render(<App />);
    await signIn();
    await fireEvent.press((await screen.findAllByText('Profile'))[0]!);
    await fireEvent.press(await screen.findByTestId('row-settings'));
    await fireEvent.press(await screen.findByTestId('language-nl'));
    expect(await screen.findAllByText('Profiel')).not.toHaveLength(0);
    expect(usePreferencesStore.getState().language).toBe('nl');
    // Emails and push notifications follow the profile language on the server.
    await screen.findAllByText('Profiel');
    expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ preferredLanguage: 'nl' });
  });
});

describe('useFormatMoney', () => {
  function Price() {
    const format = useFormatMoney();
    return <Text testID="price">{format(money(1250))}</Text>;
  }

  it('formats currency for the active language', async () => {
    usePreferencesStore.setState({ language: 'nl' });
    await render(
      <AppProviders queryClient={createQueryClient()}>
        <Price />
      </AppProviders>,
    );
    // The default text normalizer collapses whitespace, including the non-breaking space from Intl.
    expect(await screen.findByText('€ 12,50')).toBeTruthy();
  });
});
