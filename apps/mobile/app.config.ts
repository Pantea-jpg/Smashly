import type { ExpoConfig } from 'expo/config';

/**
 * One codebase, three app variants, chosen by APP_VARIANT in the EAS build profile (eas.json):
 *   development – dev client against a local API (APNs sandbox)
 *   staging     – "Training Wallet (Staging)", its own bundle id and URL scheme, so testers can
 *                 install it next to the real app; talks to the staging API
 *   production  – the App Store app
 * The server's APNS_BUNDLE_ID and APP_LINK_BASE must match the variant (render.yaml does this).
 */
type Variant = 'development' | 'staging' | 'production';
const requestedVariant = process.env['APP_VARIANT'] as string | undefined;
const variant: Variant =
  requestedVariant === 'staging' || requestedVariant === 'development'
    ? requestedVariant
    : 'production';
const easProjectId = process.env['EAS_PROJECT_ID'] as string | undefined;

const VARIANTS: Record<Variant, { name: string; bundleId: string; scheme: string }> = {
  development: {
    name: 'Training Wallet (Dev)',
    bundleId: 'com.trainingwallet.app.dev',
    scheme: 'trainingwallet-dev',
  },
  staging: {
    name: 'Training Wallet (Staging)',
    bundleId: 'com.trainingwallet.app.staging',
    scheme: 'trainingwallet-staging',
  },
  production: {
    name: 'Training Wallet',
    bundleId: 'com.trainingwallet.app',
    scheme: 'trainingwallet',
  },
};
const v = VARIANTS[variant];

const config: ExpoConfig = {
  name: v.name,
  slug: 'training-wallet',
  scheme: v.scheme,
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: v.bundleId,
    supportsTablet: false,
    // App Store export compliance: only standard HTTPS/TLS, no proprietary encryption.
    config: { usesNonExemptEncryption: false },
    // Apple privacy manifest (required for App Store submission since 2024).
    privacyManifests: {
      NSPrivacyTracking: false, // no tracking, no ads, no data brokers
      NSPrivacyTrackingDomains: [],
      // "Required reason" APIs used by React Native, Expo and AsyncStorage, with Apple's codes.
      NSPrivacyAccessedAPITypes: [
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
          NSPrivacyAccessedAPITypeReasons: ['CA92.1'], // app's own settings
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
          NSPrivacyAccessedAPITypeReasons: ['C617.1'], // files in the app's own container
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
          NSPrivacyAccessedAPITypeReasons: ['35F9.1'], // elapsed time (timers, animations)
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
          NSPrivacyAccessedAPITypeReasons: ['E174.1'], // check space before writing files
        },
      ],
      // Data the app collects, all linked to the member's account, none used for tracking.
      // Must match the App Store privacy answers in docs/11-app-store.md.
      NSPrivacyCollectedDataTypes: [
        ['NSPrivacyCollectedDataTypeName', ['NSPrivacyCollectedDataTypePurposeAppFunctionality']],
        [
          'NSPrivacyCollectedDataTypeEmailAddress',
          ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        ],
        [
          'NSPrivacyCollectedDataTypePhoneNumber',
          ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        ],
        [
          'NSPrivacyCollectedDataTypePhotosorVideos',
          ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        ],
        [
          'NSPrivacyCollectedDataTypePurchaseHistory',
          ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        ],
        ['NSPrivacyCollectedDataTypeUserID', ['NSPrivacyCollectedDataTypePurposeAppFunctionality']],
        [
          'NSPrivacyCollectedDataTypeDeviceID',
          ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        ],
        [
          'NSPrivacyCollectedDataTypeCrashData',
          ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        ],
      ].map(([type, purposes]) => ({
        NSPrivacyCollectedDataType: type as string,
        NSPrivacyCollectedDataTypeLinked: type !== 'NSPrivacyCollectedDataTypeCrashData',
        NSPrivacyCollectedDataTypeTracking: false,
        NSPrivacyCollectedDataTypePurposes: purposes as string[],
      })),
    },
  },
  android: {
    package: v.bundleId,
    adaptiveIcon: {
      backgroundColor: '#FFFFFF',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
  },
  web: { favicon: './assets/favicon.png' },
  // Phase 9: the React Compiler memoizes components and callbacks at build time, so list rows
  // and cards do not re-render when an unrelated piece of state changes. The code already obeys
  // its rules (eslint-plugin-react-hooks compiler rules run in CI).
  experiments: { reactCompiler: true },
  extra: {
    variant,
    // EAS project id, written by `eas init` (docs/09-deployment.md); needed for EAS Build/Update.
    ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
  },
  plugins: [
    ['expo-localization', { supportedLocales: ['en', 'nl'] }],
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 160,
        resizeMode: 'contain',
        backgroundColor: '#FFFFFF',
        dark: { image: './assets/splash-icon.png', backgroundColor: '#000000' },
      },
    ],
    [
      'expo-image-picker',
      {
        // Shown by iOS when choosing a profile picture. Camera and microphone are not used.
        photosPermission: 'Choose a photo from your library to use as your profile picture.',
        cameraPermission: false,
        microphonePermission: false,
      },
    ],
    [
      '@stripe/stripe-react-native',
      {
        // Apple Pay merchant id (create it in the Apple Developer account).
        merchantIdentifier:
          (process.env['APPLE_MERCHANT_ID'] as string | undefined) ??
          'merchant.com.trainingwallet.app',
        enableGooglePay: false,
      },
    ],
    [
      'expo-notifications',
      {
        // aps-environment entitlement: development builds use the APNs sandbox, TestFlight and
        // App Store builds production (must match APNS_ENVIRONMENT on the server).
        mode: process.env['APNS_MODE'] === 'production' ? 'production' : 'development',
      },
    ],
  ],
};

export default config;
