import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator } from 'react-native';
import { ApiError, httpRequest } from '../../../shared/api/http';
import { sessionController, useSessionStore } from '../../../shared/auth/session';
import { useErrorMessage } from '../../../shared/i18n/useErrorMessage';
import { AppText } from '../../../shared/ui/AppText';
import { Button } from '../../../shared/ui/Button';
import { Card } from '../../../shared/ui/Card';
import { FormError, FormScreen } from '../../../shared/ui/FormScreen';

/**
 * Opened from the emailed link (trainingwallet://verify-email?token=…), signed in or not.
 * Verifies automatically on open.
 */
export function VerifyEmailScreen({
  token,
  onDone,
}: {
  token: string | undefined;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation('auth');
  const errorMessage = useErrorMessage();
  const verify = useMutation({
    mutationFn: async () => {
      if (!token) throw new ApiError('INVALID_TOKEN', 400, 'Missing token');
      await httpRequest({
        method: 'POST',
        path: '/auth/email/verify',
        body: { token },
        language: i18n.language,
      });
      if (useSessionStore.getState().status === 'signedIn') {
        await sessionController.reloadUser();
      }
    },
  });
  const { mutate } = verify;

  useEffect(() => {
    mutate();
  }, [mutate]);

  return (
    <FormScreen title={t('verify.verifying')} testID="verify-email-screen">
      {verify.isPending ? <ActivityIndicator /> : null}
      <FormError message={errorMessage(verify.error)} />
      {verify.isSuccess ? (
        <Card>
          <AppText>{t('verify.success')}</AppText>
        </Card>
      ) : null}
      {!verify.isPending ? <Button label={t('verify.continue')} onPress={onDone} /> : null}
    </FormScreen>
  );
}
