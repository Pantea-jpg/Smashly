import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { RegisterRequestSchema } from '@tw/contracts';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { sessionController } from '../../../shared/auth/session';
import { useEffectiveLanguage } from '../../../shared/i18n/I18nProvider';
import { useErrorMessage } from '../../../shared/i18n/useErrorMessage';
import { AppText } from '../../../shared/ui/AppText';
import { Button } from '../../../shared/ui/Button';
import { Card } from '../../../shared/ui/Card';
import { FormError, FormScreen } from '../../../shared/ui/FormScreen';
import { FormTextField } from '../../../shared/ui/FormTextField';
import type { AuthScreenProps } from '../navigation';

/** The form collects everything except the language, which comes from the app setting. */
const RegisterFormSchema = RegisterRequestSchema.omit({
  preferredLanguage: true,
  phone: true,
}).extend({
  // An empty optional field is "not provided", not an invalid phone number.
  phone: z
    .string()
    .trim()
    .transform((value) => (value === '' ? undefined : value))
    .pipe(RegisterRequestSchema.shape.phone),
});
type RegisterForm = z.input<typeof RegisterFormSchema>;

export function RegisterScreen({ navigation }: AuthScreenProps<'Register'>) {
  const { t } = useTranslation('auth');
  const language = useEffectiveLanguage();
  const errorMessage = useErrorMessage();
  const { control, handleSubmit } = useForm<
    RegisterForm,
    unknown,
    z.output<typeof RegisterFormSchema>
  >({
    resolver: zodResolver(RegisterFormSchema),
    defaultValues: { email: '', password: '', firstName: '', lastName: '', phone: '' },
  });
  const register = useMutation({
    mutationFn: (values: z.output<typeof RegisterFormSchema>) =>
      sessionController.register({
        ...values,
        ...(values.phone ? { phone: values.phone } : {}),
        preferredLanguage: language,
      }),
  });

  if (register.data?.status === 'PENDING_APPROVAL') {
    return (
      <FormScreen title={t('register.pendingTitle')}>
        <Card>
          <AppText>{t('register.pendingBody')}</AppText>
        </Card>
        <Button label={t('register.signIn')} onPress={() => navigation.navigate('Login')} />
      </FormScreen>
    );
  }

  const submit = handleSubmit((values) => register.mutate(values));

  return (
    <FormScreen title={t('register.title')} testID="register-screen">
      <FormError message={errorMessage(register.error)} />
      <FormTextField
        control={control}
        name="firstName"
        label={t('fields.firstName')}
        autoComplete="given-name"
        textContentType="givenName"
      />
      <FormTextField
        control={control}
        name="lastName"
        label={t('fields.lastName')}
        autoComplete="family-name"
        textContentType="familyName"
      />
      <FormTextField
        control={control}
        name="email"
        label={t('fields.email')}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        textContentType="username"
      />
      <FormTextField
        control={control}
        name="password"
        label={t('fields.password')}
        hint={t('hints.password')}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
      />
      <FormTextField
        control={control}
        name="phone"
        label={t('fields.phone')}
        keyboardType="phone-pad"
        autoComplete="tel"
        textContentType="telephoneNumber"
      />
      <Button
        testID="register-submit"
        label={t('register.submit')}
        loading={register.isPending}
        onPress={() => void submit()}
      />
      <Button
        variant="link"
        label={`${t('register.haveAccount')} ${t('register.signIn')}`}
        onPress={() => navigation.navigate('Login')}
      />
    </FormScreen>
  );
}
