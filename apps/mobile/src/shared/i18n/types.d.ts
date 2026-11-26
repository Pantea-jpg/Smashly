import type { resources } from '@tw/i18n';
import 'i18next';

// Type-safe translation keys: t('navigation:user.home') is checked at compile time.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: (typeof resources)['en'];
    returnNull: false;
  }
}
