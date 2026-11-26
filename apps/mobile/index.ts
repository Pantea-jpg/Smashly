import { registerRootComponent } from 'expo';
import { App } from './src/app/App';
import { initSentry } from './src/shared/observability/sentry';

// Crash reporting starts before anything else renders (no-op without EXPO_PUBLIC_SENTRY_DSN).
initSentry();

// Registers the root component for both Expo Go and native (development/production) builds.
registerRootComponent(App);
