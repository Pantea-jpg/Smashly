import enAdmin from './locales/en/admin.json';
import enAuth from './locales/en/auth.json';
import enCommon from './locales/en/common.json';
import enEmails from './locales/en/emails.json';
import enErrors from './locales/en/errors.json';
import enManage from './locales/en/manage.json';
import enMember from './locales/en/member.json';
import enNavigation from './locales/en/navigation.json';
import enNotifications from './locales/en/notifications.json';
import enProfile from './locales/en/profile.json';
import enSettings from './locales/en/settings.json';
import nlAdmin from './locales/nl/admin.json';
import nlAuth from './locales/nl/auth.json';
import nlCommon from './locales/nl/common.json';
import nlEmails from './locales/nl/emails.json';
import nlErrors from './locales/nl/errors.json';
import nlManage from './locales/nl/manage.json';
import nlMember from './locales/nl/member.json';
import nlNavigation from './locales/nl/navigation.json';
import nlNotifications from './locales/nl/notifications.json';
import nlProfile from './locales/nl/profile.json';
import nlSettings from './locales/nl/settings.json';

/**
 * To add a language: create src/locales/<code>/*.json with every namespace,
 * register it in `resources` below and add the code to SUPPORTED_LANGUAGES.
 * `pnpm i18n:check` fails CI if any key is missing.
 */
export const SUPPORTED_LANGUAGES = ['en', 'nl'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'en';

/**
 * `emails` is rendered server-side only; `notifications` is shared: the app renders the in-app
 * list and the server renders push texts from the same templates (see ./notifications.ts).
 */
export const NAMESPACES = [
  'common',
  'navigation',
  'settings',
  'auth',
  'profile',
  'admin',
  'member',
  'manage',
  'notifications',
  'errors',
  'emails',
] as const;
export type Namespace = (typeof NAMESPACES)[number];
export const DEFAULT_NAMESPACE: Namespace = 'common';

export const resources = {
  en: {
    common: enCommon,
    navigation: enNavigation,
    settings: enSettings,
    auth: enAuth,
    profile: enProfile,
    admin: enAdmin,
    member: enMember,
    manage: enManage,
    notifications: enNotifications,
    errors: enErrors,
    emails: enEmails,
  },
  nl: {
    common: nlCommon,
    navigation: nlNavigation,
    settings: nlSettings,
    auth: nlAuth,
    profile: nlProfile,
    admin: nlAdmin,
    member: nlMember,
    manage: nlManage,
    notifications: nlNotifications,
    errors: nlErrors,
    emails: nlEmails,
  },
} as const satisfies Record<Language, Record<Namespace, unknown>>;

/** BCP-47 tags used for Intl formatting per language. */
export const INTL_LOCALE: Record<Language, string> = {
  en: 'en-GB', // EUR-region English: "€12.50", 24h clock, day-month order
  nl: 'nl-NL',
};

export function isSupportedLanguage(value: string): value is Language {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Picks the best supported language from preferred tags (device or Accept-Language order).
 * "nl-BE" → "nl", "en-US" → "en", unknown → DEFAULT_LANGUAGE.
 */
export function resolveLanguage(preferredTags: readonly string[]): Language {
  for (const tag of preferredTags) {
    const base = tag.toLowerCase().split(/[-_]/)[0] ?? '';
    if (isSupportedLanguage(base)) return base;
  }
  return DEFAULT_LANGUAGE;
}

export * from './notifications';
