import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { LoginRequestSchema } from '@tw/contracts';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import type { z } from 'zod';
import { sessionController } from '../../../shared/auth/session';
import { useErrorMessage } from '../../../shared/i18n/useErrorMessage';
import { Button } from '../../../shared/ui/Button';
import { FormError, FormScreen } from '../../../shared/ui/FormScreen';
import { FormTextField } from '../../../shared/ui/FormTextField';
import type { AuthScreenProps } from '../navigation';

type LoginForm = z.input<typeof LoginRequestSchema>;

export function LoginScreen({ navigation }: AuthScreenProps<'Login'>) {
  const { t } = useTranslation('auth');
  const errorMessage = useErrorMessage();
  const { control, handleSubmit } = useForm<
    LoginForm,
    unknown,
    z.output<typeof LoginRequestSchema>
  >({ resolver: zodResolver(LoginRequestSchema), defaultValues: { email: '', password: '' } });
  // On success the session store switches the root navigator; nothing to do here.
  const login = useMutation({ mutationFn: sessionController.login.bind(sessionController) });
  const submit = handleSubmit((values) => login.mutate(values));

  return (
    <FormScreen title={t('login.title')} subtitle={t('login.subtitle')} testID="login-screen">
      <FormError message={errorMessage(login.error)} />
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
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
      />
      <Button
        testID="login-submit"
        label={t('login.submit')}
        loading={login.isPending}
        onPress={() => void submit()}
      />
      <Button
        variant="link"
        label={t('login.forgot')}
        onPress={() => navigation.navigate('ForgotPassword')}
      />
      <View>
        <Button
          variant="link"
          testID="go-register"
          label={`${t('login.noAccount')} ${t('login.register')}`}
          onPress={() => navigation.navigate('Register')}
        />
      </View>
    </FormScreen>
  );
}
