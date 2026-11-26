import { handleURLCallback } from '@stripe/stripe-react-native';
import { focusManager } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState, Linking } from 'react-native';
import { STRIPE_RETURN_URL } from '../shared/config/appScheme';

/**
 * React Query in React Native: "window focus" = the app coming to the foreground, so balances
 * and lists refresh when the member returns to the app (e.g. after paying in the bank app).
 */
export function useAppStateFocus(): void {
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      focusManager.setFocused(state === 'active');
    });
    return () => subscription.remove();
  }, []);
}

/** iDEAL and 3-D Secure return to `<scheme>://stripe-redirect`; hand that back to Stripe. */
export function useStripeReturnLinks(): void {
  useEffect(() => {
    const forward = (url: string | null | undefined) => {
      if (url?.startsWith(STRIPE_RETURN_URL)) void handleURLCallback(url);
    };
    void Linking.getInitialURL().then(forward);
    const subscription = Linking.addEventListener('url', ({ url }) => forward(url));
    return () => subscription.remove();
  }, []);
}
