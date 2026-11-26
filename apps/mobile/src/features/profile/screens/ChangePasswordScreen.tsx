import { zodResolver } from '@hookform/resolvers/zod';
import { ChangePasswordRequestSchema } from '@tw/contracts';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useErrorMessage } from '../../../shared/i18n/useErrorMessage';
import { AppText } from '../../../shared/ui/AppText';
import { Button } from '../../../shared/ui/Button';
import { Card } from '../../../shared/ui/Card';
import { FormError } from '../../../shared/ui/FormScreen';
import { FormTextField } from '../../../shared/ui/FormTextField';
import { Screen } from '../../../shared/ui/Screen';
import { useChangePassword } from '../api';
import type { ProfileScreenProps } from '../navigation';

type ChangePasswordForm = z.input<typeof ChangePasswordRequestSchema>;

export function ChangePasswordScreen({ navigation }: ProfileScreenProps<'ChangePassword'>) {
  const { t } = useTranslation('profile');
  const { t: tAuth } = useTranslation('auth');
  const errorMessage = useErrorMessage();
  const change = useChangePassword();
  const { control, handleSubmit } = useForm<ChangePasswordForm>({
    resolver: zodResolver(ChangePasswordRequestSchema),
    defaultValues: { currentPassword: '', newPassword: '' },
  });

  if (change.isSuccess) {
    return (
      <Screen>
        <Card>
          <AppText>{t('password.done')}</AppText>
        </Card>
        <Button label={tAuth('verify.continue')} onPress={() => navigation.goBack()} />
      </Screen>
    );
  }

  return (
    <Screen testID="change-password-screen">
      <FormError message={errorMessage(change.error)} />
      <FormTextField
        control={control}
        name="currentPassword"
        label={t('password.current')}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
      />
      <FormTextField
        control={control}
        name="newPassword"
        label={tAuth('fields.newPassword')}
        hint={tAuth('hints.password')}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
      />
      <Button
        testID="submit-password"
        label={t('password.submit')}
        loading={change.isPending}
        onPress={() => void handleSubmit((values) => change.mutate(values))()}
      />
    </Screen>
  );
}
