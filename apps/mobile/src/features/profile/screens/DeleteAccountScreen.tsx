import { zodResolver } from '@hookform/resolvers/zod';
import { DeleteAccountRequestSchema } from '@tw/contracts';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Alert } from 'react-native';
import type { z } from 'zod';
import { useErrorMessage } from '../../../shared/i18n/useErrorMessage';
import { AppText } from '../../../shared/ui/AppText';
import { Button } from '../../../shared/ui/Button';
import { Card } from '../../../shared/ui/Card';
import { FormError } from '../../../shared/ui/FormScreen';
import { FormTextField } from '../../../shared/ui/FormTextField';
import { Screen } from '../../../shared/ui/Screen';
import { useDeleteAccount } from '../api';

type DeleteForm = z.input<typeof DeleteAccountRequestSchema>;

/** Apple requires in-app account deletion. Personal data is anonymised; money records stay. */
export function DeleteAccountScreen() {
  const { t } = useTranslation('profile');
  const { t: tc } = useTranslation('common');
  const errorMessage = useErrorMessage();
  const remove = useDeleteAccount();
  const { control, handleSubmit } = useForm<DeleteForm>({
    resolver: zodResolver(DeleteAccountRequestSchema),
    defaultValues: { password: '' },
  });

  const confirm = handleSubmit(({ password }) => {
    Alert.alert(t('delete.confirmTitle'), t('delete.confirmBody'), [
      { text: tc('actions.cancel'), style: 'cancel' },
      { text: t('delete.submit'), style: 'destructive', onPress: () => remove.mutate(password) },
    ]);
  });

  return (
    <Screen testID="delete-account-screen">
      <Card>
        <AppText>{t('delete.intro')}</AppText>
      </Card>
      <FormError message={errorMessage(remove.error)} />
      <FormTextField
        control={control}
        name="password"
        label={t('delete.password')}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
      />
      <Button
        testID="delete-account-submit"
        variant="destructive"
        label={t('delete.submit')}
        loading={remove.isPending}
        onPress={() => void confirm()}
      />
    </Screen>
  );
}
