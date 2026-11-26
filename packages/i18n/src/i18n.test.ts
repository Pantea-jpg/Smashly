import { ERROR_CODES, LanguageSchema, NotificationType } from '@tw/contracts';
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_TEMPLATE_VARIANTS,
  type NotificationFormatters,
  type NotificationTranslate,
  notificationTemplateKey,
  renderNotification,
  resolveLanguage,
  resources,
  SUPPORTED_LANGUAGES,
} from './index';

describe('resolveLanguage', () => {
  it.each([
    [['nl-NL'], 'nl'],
    [['nl_BE'], 'nl'],
    [['en-US'], 'en'],
    [['de-DE', 'nl-NL'], 'nl'],
    [['fr-FR'], 'en'],
    [[], 'en'],
  ] as const)('%o → %s', (tags, expected) => {
    expect(resolveLanguage(tags)).toBe(expected);
  });
});

describe('supported languages', () => {
  it('match the API contract', () => {
    expect([...SUPPORTED_LANGUAGES]).toEqual(LanguageSchema.options);
  });
});

describe('auth validation messages', () => {
  it.each(SUPPORTED_LANGUAGES)('cover every message key used by contracts in %s', (lang) => {
    const messages: Record<string, string> = resources[lang].auth.validation;
    for (const key of [
      'required',
      'invalid_email',
      'password_too_short',
      'password_too_long',
      'invalid_phone',
    ]) {
      expect(messages[key], `${lang}:auth.validation.${key}`).toBeTruthy();
    }
  });
});

describe('errors namespace', () => {
  it.each(SUPPORTED_LANGUAGES)('translates every API error code in %s', (lang) => {
    const errors: Record<string, string> = resources[lang].errors;
    for (const code of ERROR_CODES) {
      expect(errors[code], `${lang}:errors.${code}`).toBeTruthy();
    }
  });
});

describe('notifications namespace', () => {
  /** Minimal `t`: dotted lookup plus {{value}} interpolation, enough to exercise the templates. */
  const tFor =
    (lang: (typeof SUPPORTED_LANGUAGES)[number]): NotificationTranslate =>
    (key, values = {}) => {
      let node: unknown = resources[lang].notifications;
      for (const part of key.split('.'))
        node = (node as Record<string, unknown> | undefined)?.[part];
      if (typeof node !== 'string') throw new Error(`missing ${lang}:notifications.${key}`);
      return node.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
        const value = values[name];
        return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
      });
    };
  const format: NotificationFormatters = {
    money: (minor, currency) => `${currency} ${(minor / 100).toFixed(2)}`,
    dateTime: (iso) => `DT(${iso})`,
    time: (iso) => `T(${iso})`,
  };

  it.each(SUPPORTED_LANGUAGES)('has a title and body for every type and variant in %s', (lang) => {
    const types: Record<string, { title?: string; body?: string }> =
      resources[lang].notifications.types;
    for (const key of [...NotificationType.options, ...NOTIFICATION_TEMPLATE_VARIANTS]) {
      expect(types[key]?.title, `${lang}:notifications.types.${key}.title`).toBeTruthy();
      expect(types[key]?.body, `${lang}:notifications.types.${key}.body`).toBeTruthy();
    }
  });

  it('picks variants from the params', () => {
    const key = (type: string, params: Record<string, unknown>) =>
      notificationTemplateKey({ type, params });
    expect(key('TRAINING_CHARGED', { shortfallMinor: 0 })).toBe('TRAINING_CHARGED');
    expect(key('TRAINING_CHARGED', { shortfallMinor: 200 })).toBe('TRAINING_CHARGED_DEBT');
    expect(key('TRAINING_CANCELLED', { refunded: true })).toBe('TRAINING_CANCELLED_REFUNDED');
    expect(key('TRAINING_CREATED', { seriesId: 'x' })).toBe('TRAINING_CREATED_SERIES');
    expect(key('TRAINING_REMINDER', { window: '24h' })).toBe('TRAINING_REMINDER');
    expect(key('TRAINING_REMINDER', { window: '2h' })).toBe('TRAINING_REMINDER_SOON');
  });

  it('renders every value with the given formatters, in Dutch', () => {
    const t = tFor('nl');
    expect(
      renderNotification(
        t,
        {
          type: 'TRAINING_CHARGED',
          params: { title: 'Dinsdag', amountMinor: 1000, shortfallMinor: 400, currency: 'EUR' },
        },
        format,
      ),
    ).toEqual({
      title: 'Training afgeschreven',
      body: 'EUR 10.00 voor Dinsdag. EUR 4.00 staat open.',
    });
    expect(
      renderNotification(
        t,
        { type: 'TRAINING_REMINDER', params: { title: 'Dinsdag', startsAt: 'S', window: '2h' } },
        format,
      ).body,
    ).toBe('Dinsdag begint om T(S).');
    expect(
      renderNotification(
        t,
        { type: 'RESERVATION_CONFIRMED', params: { title: 'Dinsdag', status: 'ATTENDING' } },
        format,
      ).body,
    ).toBe('Je reactie voor Dinsdag is nu: aangemeld.');
  });
});
