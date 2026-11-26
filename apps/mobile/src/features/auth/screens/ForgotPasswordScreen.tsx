import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { AcceptedSchema, ForgotPasswordRequestSchema } from '@tw/contracts';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { httpRequest } from '../../../shared/api/http';
import { useErrorMessage } from '../../../shared/i18n/useErrorMessage';
import { AppText } from '../../../shared/ui/AppText';
import { Button } from '../../../shared/ui/Button';
import { Card } from '../../../shared/ui/Card';
import { FormError, FormScreen } from '../../../shared/ui/FormScreen';
import { FormTextField } from '../../../shared/ui/FormTextField';
import type { AuthScreenProps } from '../navigation';

type ForgotForm = z.input<typeof ForgotPasswordRequestSchema>;

export function ForgotPasswordScreen({ navigation }: AuthScreenProps<'ForgotPassword'>) {
  const { t, i18n } = useTranslation('auth');
  const errorMessage = useErrorMessage();
  const { control, handleSubmit } = useForm<
    ForgotForm,
    unknown,
    z.output<typeof ForgotPasswordRequestSchema>
  >({
    resolver: zodResolver(ForgotPasswordRequestSchema),
    defaultValues: { email: '' },
  });
  const forgot = useMutation({
    mutationFn: async (values: z.output<typeof ForgotPasswordRequestSchema>) => {
      await httpRequest({
        method: 'POST',
        path: '/auth/password/forgot',
        body: values,
        language: i18n.language,
        schema: AcceptedSchema,
      });
      return values.email;
    },
  });

  if (forgot.isSuccess) {
    return (
      <FormScreen title={t('forgot.sentTitle')} testID="forgot-sent">
        <Card>
          <AppText>{t('forgot.sentBody', { email: forgot.data })}</AppText>
        </Card>
        <Button label={t('forgot.back')} onPress={() => navigation.navigate('Login')} />
      </FormScreen>
    );
  }

  return (
    <FormScreen title={t('forgot.title')} subtitle={t('forgot.intro')}>
      <FormError message={errorMessage(forgot.error)} />
      <FormTextField
        control={control}
        name="email"
        label={t('fields.email')}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
      />
      <Button
        testID="forgot-submit"
        label={t('forgot.submit')}
        loading={forgot.isPending}
        onPress={() => void handleSubmit((values) => forgot.mutate(values))()}
      />
      <Button variant="link" label={t('forgot.back')} onPress={() => navigation.goBack()} />
    </FormScreen>
  );
}
