import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { sessionController, useSessionStore } from '../shared/auth/session';
import { I18nProvider } from '../shared/i18n/I18nProvider';
import { ThemeProvider, useTheme } from '../shared/theme/ThemeProvider';
import { usePreferencesStore } from '../stores/preferences.store';
import { useAppStateFocus, useStripeReturnLinks } from './lifecycle';
import { RootNavigator } from './navigation/RootNavigator';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Unused cache entries are dropped after 5 minutes. Under Jest that timer would keep the
        // test process alive for 5 minutes after the last test, so tests never garbage-collect.
        gcTime: process.env.NODE_ENV === 'test' ? Infinity : 5 * 60_000,
        retry: 2,
        refetchOnWindowFocus: true, // "focus" = app back in the foreground (see lifecycle.ts)
      },
      mutations: {
        retry: 0, // Never auto-retry mutations; money endpoints rely on explicit idempotency keys.
        gcTime: process.env.NODE_ENV === 'test' ? Infinity : 5 * 60_000,
      },
    },
  });
}

/** Waits for persisted preferences (language, theme) so the first frame is already correct. */
function usePreferencesHydrated(): boolean {
  return useSyncExternalStore(
    (onChange) => usePreferencesStore.persist.onFinishHydration(onChange),
    () => usePreferencesStore.persist.hasHydrated(),
  );
}

function ThemedStatusBar() {
  const theme = useTheme();
  return <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />;
}

export function AppProviders({
  children,
  queryClient,
}: {
  children: ReactNode;
  queryClient: QueryClient;
}) {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ThemeProvider>
            <ThemedStatusBar />
            {children}
          </ThemeProvider>
        </I18nProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

/** Restores the stored session once on launch (Keychain refresh token → fresh session). */
function useRestoreSession(): void {
  useEffect(() => {
    sessionController.restore().catch(() => {
      // Unexpected failure: fall back to the sign-in screen rather than a blank app.
      useSessionStore.setState({ status: 'signedOut' });
    });
  }, []);
}

export function App() {
  const [queryClient] = useState(createQueryClient);
  const hydrated = usePreferencesHydrated();
  useRestoreSession();
  useAppStateFocus();
  useStripeReturnLinks();

  // The native splash screen stays visible until the first render returns content.
  if (!hydrated) return null;

  return (
    <AppProviders queryClient={queryClient}>
      <RootNavigator />
    </AppProviders>
  );
}
