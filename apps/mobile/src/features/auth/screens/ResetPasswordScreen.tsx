import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { NewPasswordSchema } from '@tw/contracts';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ApiError, httpRequest } from '../../../shared/api/http';
import { useErrorMessage } from '../../../shared/i18n/useErrorMessage';
import { AppText } from '../../../shared/ui/AppText';
import { Button } from '../../../shared/ui/Button';
import { Card } from '../../../shared/ui/Card';
import { FormError, FormScreen } from '../../../shared/ui/FormScreen';
import { FormTextField } from '../../../shared/ui/FormTextField';
import type { AuthScreenProps } from '../navigation';

const ResetFormSchema = z.object({ newPassword: NewPasswordSchema });
type ResetForm = z.infer<typeof ResetFormSchema>;

/** Opened from the emailed link: trainingwallet://reset-password?token=… */
export function ResetPasswordScreen({ navigation, route }: AuthScreenProps<'ResetPassword'>) {
  const { t, i18n } = useTranslation('auth');
  const errorMessage = useErrorMessage();
  const token = route.params?.token;
  const { control, handleSubmit } = useForm<ResetForm>({
    resolver: zodResolver(ResetFormSchema),
    defaultValues: { newPassword: '' },
  });
  const reset = useMutation({
    mutationFn: async ({ newPassword }: ResetForm) => {
      if (!token) throw new ApiError('INVALID_TOKEN', 400, 'Missing token');
      await httpRequest({
        method: 'POST',
        path: '/auth/password/reset',
        body: { token, newPassword },
        language: i18n.language,
      });
    },
  });

  if (reset.isSuccess) {
    return (
      <FormScreen title={t('reset.successTitle')}>
        <Card>
          <AppText>{t('reset.successBody')}</AppText>
        </Card>
        <Button label={t('register.signIn')} onPress={() => navigation.navigate('Login')} />
      </FormScreen>
    );
  }

  return (
    <FormScreen title={t('reset.title')}>
      <FormError
        message={
          token ? errorMessage(reset.error) : errorMessage(new ApiError('INVALID_TOKEN', 400, ''))
        }
      />
      <FormTextField
        control={control}
        name="newPassword"
        label={t('fields.newPassword')}
        hint={t('hints.password')}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
      />
      <Button
        label={t('reset.submit')}
        loading={reset.isPending}
        disabled={!token}
        onPress={() => void handleSubmit((values) => reset.mutate(values))()}
      />
    </FormScreen>
  );
}
