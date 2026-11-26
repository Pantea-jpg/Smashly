import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { Linking } from 'react-native';
import { apiError, mockApi } from '../../../test/api';
import { App } from '../../app/App';
import { resetSessionStoreForTests } from '../../shared/auth/session';
import { usePreferencesStore } from '../../stores/preferences.store';

jest.setTimeout(20_000);
const keychain = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const TOKEN = 'emailed-token-abcdefghijklmnopqrstuvwxyz';

/** Simulates the app being opened from an emailed link. */
function openedFrom(url: string | null) {
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(url);
}

beforeEach(() => {
  keychain.clear();
  resetSessionStoreForTests();
  usePreferencesStore.setState({ language: 'en', appearance: 'system' });
  openedFrom(null);
});

describe('forgot password', () => {
  it('sends the link and never reveals whether the account exists', async () => {
    const requests = mockApi({
      'POST /auth/password/forgot': () => ({ status: 202, body: { data: { accepted: true } } }),
    });
    await render(<App />);
    await fireEvent.press(await screen.findByText('Forgot password?'));
    await fireEvent.changeText(await screen.findByTestId('field-email'), 'Anna@Example.test ');
    await fireEvent.press(screen.getByTestId('forgot-submit'));
    expect(await screen.findByTestId('forgot-sent')).toBeTruthy();
    expect(screen.getByText(/If an account exists for anna@example.test/)).toBeTruthy();
    expect(requests.find((r) => r.path === '/auth/password/forgot')?.body).toEqual({
      email: 'anna@example.test',
    });
  });

  it('validates the email on the device', async () => {
    const requests = mockApi({});
    await render(<App />);
    await fireEvent.press(await screen.findByText('Forgot password?'));
    await fireEvent.changeText(await screen.findByTestId('field-email'), 'not-an-email');
    await fireEvent.press(screen.getByTestId('forgot-submit'));
    await waitFor(() => expect(screen.queryByTestId('forgot-sent')).toBeNull());
    expect(requests).toHaveLength(0);
  });
});

describe('reset password link', () => {
  it('sets a new password with the token from the link', async () => {
    openedFrom(`trainingwallet://reset-password?token=${TOKEN}`);
    const requests = mockApi({ 'POST /auth/password/reset': () => ({ status: 204 }) });
    await render(<App />);
    expect(await screen.findByText('Choose a new password')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('field-newPassword'), 'a much better password');
    await fireEvent.press(screen.getByText('Save password'));
    expect(await screen.findByText('Password changed')).toBeTruthy();
    expect(requests.find((r) => r.path === '/auth/password/reset')?.body).toEqual({
      token: TOKEN,
      newPassword: 'a much better password',
    });
  });

  it('explains an expired or used link', async () => {
    openedFrom(`trainingwallet://reset-password?token=${TOKEN}`);
    mockApi({ 'POST /auth/password/reset': () => apiError(400, 'INVALID_TOKEN') });
    await render(<App />);
    await fireEvent.changeText(
      await screen.findByTestId('field-newPassword'),
      'a much better password',
    );
    await fireEvent.press(screen.getByText('Save password'));
    await waitFor(() => expect(screen.queryByText('Password changed')).toBeNull());
    expect(await screen.findByText(/link/i)).toBeTruthy();
  });
});

describe('verify email link', () => {
  it('confirms the address as soon as the link opens', async () => {
    openedFrom(`trainingwallet://verify-email?token=${TOKEN}`);
    const requests = mockApi({ 'POST /auth/email/verify': () => ({ status: 204 }) });
    await render(<App />);
    expect(await screen.findByTestId('verify-email-screen')).toBeTruthy();
    expect(await screen.findByText('Your email address is confirmed.')).toBeTruthy();
    expect(requests.find((r) => r.path === '/auth/email/verify')?.body).toEqual({ token: TOKEN });
    await fireEvent.press(screen.getByText('Continue'));
    expect(await screen.findByTestId('login-screen')).toBeTruthy();
  });

  it('shows an error for an invalid link and still lets the member continue', async () => {
    openedFrom(`trainingwallet://verify-email?token=${TOKEN}`);
    mockApi({ 'POST /auth/email/verify': () => apiError(400, 'INVALID_TOKEN') });
    await render(<App />);
    expect(await screen.findByText('Continue')).toBeTruthy();
    expect(screen.queryByText('Your email address is confirmed.')).toBeNull();
  });
});
