import { zodResolver } from '@hookform/resolvers/zod';
import { PhoneSchema } from '@tw/contracts';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useErrorMessage } from '../../../shared/i18n/useErrorMessage';
import { Button } from '../../../shared/ui/Button';
import { FormError } from '../../../shared/ui/FormScreen';
import { FormTextField } from '../../../shared/ui/FormTextField';
import { Screen } from '../../../shared/ui/Screen';
import { useProfile, useUpdateProfile } from '../api';
import type { ProfileScreenProps } from '../navigation';

const EditProfileFormSchema = z.object({
  firstName: z.string().trim().min(1, { message: 'required' }).max(80),
  lastName: z.string().trim().min(1, { message: 'required' }).max(80),
  // Empty means "remove my phone number".
  phone: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .pipe(PhoneSchema.nullable()),
});
type EditProfileForm = z.input<typeof EditProfileFormSchema>;

export function EditProfileScreen({ navigation }: ProfileScreenProps<'EditProfile'>) {
  const { t } = useTranslation('profile');
  const { t: tAuth } = useTranslation('auth');
  const errorMessage = useErrorMessage();
  const profile = useProfile().data;
  const update = useUpdateProfile();
  const { control, handleSubmit } = useForm<
    EditProfileForm,
    unknown,
    z.output<typeof EditProfileFormSchema>
  >({
    resolver: zodResolver(EditProfileFormSchema),
    values: {
      firstName: profile?.firstName ?? '',
      lastName: profile?.lastName ?? '',
      phone: profile?.phone ?? '',
    },
  });

  const submit = handleSubmit((values) =>
    update.mutate(values, { onSuccess: () => navigation.goBack() }),
  );

  return (
    <Screen testID="edit-profile-screen">
      <FormError message={errorMessage(update.error)} />
      <FormTextField
        control={control}
        name="firstName"
        label={tAuth('fields.firstName')}
        autoComplete="given-name"
      />
      <FormTextField
        control={control}
        name="lastName"
        label={tAuth('fields.lastName')}
        autoComplete="family-name"
      />
      <FormTextField
        control={control}
        name="phone"
        label={tAuth('fields.phone')}
        keyboardType="phone-pad"
        autoComplete="tel"
      />
      <Button
        testID="save-profile"
        label={t('edit.save')}
        loading={update.isPending}
        onPress={() => void submit()}
      />
    </Screen>
  );
}
