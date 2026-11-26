import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/http';

/** Maps any thrown error to a translated, user-facing message (never the server's English text). */
export function useErrorMessage(): (error: unknown) => string | null {
  const { t } = useTranslation('errors');
  return useCallback(
    (error: unknown) => {
      if (!error) return null;
      const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
      return t(code, { defaultValue: t('INTERNAL_ERROR') });
    },
    [t],
  );
}

/** Translates Zod issue messages (which are i18n keys such as "password_too_short"). */
export function useValidationMessage(): (message: string | undefined) => string | undefined {
  const { t } = useTranslation('auth');
  return useCallback(
    (message: string | undefined) =>
      message ? t(`validation.${message}`, { defaultValue: t('validation.invalid') }) : undefined,
    [t],
  );
}
