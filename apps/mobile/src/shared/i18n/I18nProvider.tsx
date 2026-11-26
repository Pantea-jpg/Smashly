import { INTL_LOCALE, type Language } from '@tw/i18n';
import { type ReactNode, useEffect, useState } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { usePreferencesStore } from '../../stores/preferences.store';
import { setApiLanguage } from '../auth/session';
import { createI18n, detectDeviceLanguage } from './i18n';

/** Effective language: the user's manual choice, otherwise the device language. */
export function useEffectiveLanguage(): Language {
  const chosen = usePreferencesStore((state) => state.language);
  return chosen ?? detectDeviceLanguage();
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const language = useEffectiveLanguage();
  const [instance] = useState(() => createI18n(language));

  useEffect(() => {
    setApiLanguage(language);
    if (instance.language !== language) {
      void instance.changeLanguage(language);
    }
  }, [instance, language]);

  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}

/** BCP-47 locale for Intl date/number/currency formatting in the active language. */
export function useIntlLocale(): string {
  const { i18n } = useTranslation();
  const language = (i18n.resolvedLanguage ?? 'en') as Language;
  return INTL_LOCALE[language];
}
