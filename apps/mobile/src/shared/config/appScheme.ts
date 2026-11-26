import Constants from 'expo-constants';

/**
 * The app's URL scheme from app.config.ts: `trainingwallet` for the App Store app and
 * `trainingwallet-staging` for the staging build, so email links and Stripe redirects open the
 * right app when both are installed. Must match APP_LINK_BASE on the server.
 */
function readScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  const first = Array.isArray(scheme) ? scheme[0] : scheme;
  return first ?? 'trainingwallet';
}

export const APP_SCHEME = readScheme();
export const APP_LINK_PREFIX = `${APP_SCHEME}://`;
export const STRIPE_RETURN_URL = `${APP_SCHEME}://stripe-redirect`;
