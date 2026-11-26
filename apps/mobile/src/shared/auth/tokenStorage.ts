import * as SecureStore from 'expo-secure-store';

const REFRESH_TOKEN_KEY = 'tw.refreshToken.v1';

/**
 * The refresh token lives in the iOS Keychain (Android Keystore later), never in
 * AsyncStorage. "This device only": it is not synced to iCloud or restored to another device.
 * The access token is kept in memory only.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export interface TokenStorage {
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string): Promise<void>;
  clear(): Promise<void>;
}

export const secureTokenStorage: TokenStorage = {
  getRefreshToken: () => SecureStore.getItemAsync(REFRESH_TOKEN_KEY, OPTIONS),
  setRefreshToken: (token) => SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, OPTIONS),
  clear: () => SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, OPTIONS),
};
