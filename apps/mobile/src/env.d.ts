// Public build-time variables inlined by Expo (only EXPO_PUBLIC_* reach the app bundle).
// Never put secrets here: everything in the bundle is readable by anyone with the app.
declare namespace NodeJS {
  interface ProcessEnv {
    readonly EXPO_PUBLIC_API_URL?: string;
    /** Sentry DSN for crash reports (not a secret: it only allows sending events). */
    readonly EXPO_PUBLIC_SENTRY_DSN?: string;
    /** development | staging | production (Sentry environment). */
    readonly EXPO_PUBLIC_APP_ENV?: string;
  }
}
