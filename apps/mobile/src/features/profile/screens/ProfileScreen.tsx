import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, View } from 'react-native';
import { sessionController } from '../../../shared/auth/session';
import { useCanMutate } from '../../../shared/auth/viewAs';
import { useIntlLocale } from '../../../shared/i18n/I18nProvider';
import { useErrorMessage } from '../../../shared/i18n/useErrorMessage';
import { AppText } from '../../../shared/ui/AppText';
import { Avatar } from '../../../shared/ui/Avatar';
import { Button } from '../../../shared/ui/Button';
import { FormError } from '../../../shared/ui/FormScreen';
import { ListRow } from '../../../shared/ui/ListRow';
import { Screen } from '../../../shared/ui/Screen';
import { Section } from '../../../shared/ui/Section';
import { useTheme } from '../../../shared/theme/ThemeProvider';
import { AvatarPermissionError, useChangeAvatar, useProfile, useRemoveAvatar } from '../api';
import type { ProfileScreenProps } from '../navigation';

export function ProfileScreen({ navigation }: ProfileScreenProps<'ProfileHome'>) {
  const { t } = useTranslation('profile');
  const { t: tc } = useTranslation('common');
  const { t: ts } = useTranslation('settings');
  const { t: ta } = useTranslation('admin');
  const theme = useTheme();
  const locale = useIntlLocale();
  const canMutate = useCanMutate();
  const errorMessage = useErrorMessage();
  const profile = useProfile();
  const changeAvatar = useChangeAvatar();
  const removeAvatar = useRemoveAvatar();
  const signOut = useMutation({ mutationFn: () => sessionController.logout() });

  if (profile.isPending) {
    return (
      <Screen>
        <ActivityIndicator />
      </Screen>
    );
  }
  if (!profile.data) {
    return (
      <Screen>
        <FormError message={errorMessage(profile.error)} />
        <Button
          variant="secondary"
          label={tc('actions.retry')}
          onPress={() => void profile.refetch()}
        />
      </Screen>
    );
  }

  const p = profile.data;
  const avatarError =
    changeAvatar.error instanceof AvatarPermissionError
      ? t('avatar.permission')
      : changeAvatar.error
        ? t('avatar.failed')
        : null;
  const memberSince = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(
    new Date(p.createdAt),
  );

  return (
    <Screen testID="profile-screen">
      <View
        style={{ alignItems: 'center', gap: theme.spacing.sm, paddingVertical: theme.spacing.md }}
      >
        <Avatar url={p.avatarUrl} firstName={p.firstName} lastName={p.lastName} size={88} />
        <AppText variant="title2">{`${p.firstName} ${p.lastName}`.trim()}</AppText>
        <AppText tone="textSecondary">{p.email}</AppText>
        <AppText variant="footnote" tone="textSecondary">
          {t('memberSince', { date: memberSince })}
        </AppText>
        {canMutate ? (
          <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
            <Button
              variant="link"
              testID="change-avatar"
              label={t('avatar.change')}
              loading={changeAvatar.isPending}
              onPress={() => changeAvatar.mutate()}
            />
            {p.avatarUrl ? (
              <Button
                variant="link"
                label={t('avatar.remove')}
                loading={removeAvatar.isPending}
                onPress={() => removeAvatar.mutate()}
              />
            ) : null}
          </View>
        ) : null}
        <FormError message={avatarError} />
      </View>

      {!canMutate ? (
        <>
          <AppText variant="footnote" tone="textSecondary">
            {ta('viewAs.readOnly')}
          </AppText>
          <Section title={t('sections.account')}>
            <ListRow title={ta('detail.phone')} subtitle={p.phone ?? '—'} />
            <ListRow
              title={ta('detail.language')}
              subtitle={ts(`language.${p.preferredLanguage}`)}
            />
          </Section>
        </>
      ) : (
        <>
          <Section title={t('sections.account')}>
            <ListRow
              testID="row-edit-profile"
              title={t('edit.title')}
              onPress={() => navigation.navigate('EditProfile')}
            />
            <ListRow
              testID="row-change-password"
              title={t('password.title')}
              onPress={() => navigation.navigate('ChangePassword')}
            />
          </Section>
          <Section title={t('sections.preferences')}>
            <ListRow
              testID="row-notifications"
              title={t('notifications.title')}
              onPress={() => navigation.navigate('NotificationSettings')}
            />
            <ListRow
              testID="row-settings"
              title={ts('title')}
              onPress={() => navigation.navigate('AppSettings')}
            />
          </Section>
          <Button
            testID="sign-out"
            variant="secondary"
            label={tc('actions.signOut')}
            loading={signOut.isPending}
            onPress={() => signOut.mutate()}
          />
          <Section>
            <ListRow
              testID="row-delete-account"
              title={t('delete.title')}
              destructive
              onPress={() => navigation.navigate('DeleteAccount')}
            />
          </Section>
        </>
      )}
    </Screen>
  );
}
