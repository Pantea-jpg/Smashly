import { DEFAULT_NAMESPACE, type Language, NAMESPACES, resolveLanguage, resources } from '@tw/i18n';
import { getLocales } from 'expo-localization';
import i18next, { type i18n } from 'i18next';
import { initReactI18next } from 'react-i18next';

/** Best supported language for the device's preferred-language list. */
export function detectDeviceLanguage(): Language {
  return resolveLanguage(getLocales().map((locale) => locale.languageTag));
}

/**
 * Creates and initialises an i18next instance. Resources are bundled (no network),
 * so initialisation is synchronous in practice. A separate instance per call keeps tests isolated.
 */
export function createI18n(language: Language): i18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: 'en',
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NAMESPACE,
    interpolation: { escapeValue: false }, // React already escapes
    returnNull: false,
    initAsync: false,
  });
  return instance;
}
