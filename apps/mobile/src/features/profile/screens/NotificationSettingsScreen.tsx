import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Linking } from 'react-native';
import { useCanMutate } from '../../../shared/auth/viewAs';
import { useErrorMessage } from '../../../shared/i18n/useErrorMessage';
import { usePushPermission } from '../../../shared/push/usePush';
import { Button } from '../../../shared/ui/Button';
import { AppText } from '../../../shared/ui/AppText';
import { FormError } from '../../../shared/ui/FormScreen';
import { ListRow, SwitchRow } from '../../../shared/ui/ListRow';
import { Screen } from '../../../shared/ui/Screen';
import { Section } from '../../../shared/ui/Section';
import { useNotificationPreferences, useUpdateNotificationPreference } from '../api';

export function NotificationSettingsScreen() {
  const { t } = useTranslation('profile');
  const errorMessage = useErrorMessage();
  const canMutate = useCanMutate();
  const preferences = useNotificationPreferences();
  const update = useUpdateNotificationPreference();

  return (
    <Screen testID="notification-settings-screen">
      {canMutate ? <DevicePushSection /> : null}
      <AppText tone="textSecondary">{t('notifications.intro')}</AppText>
      <FormError message={errorMessage(preferences.error ?? update.error)} />
      {preferences.isPending ? <ActivityIndicator /> : null}
      {preferences.data ? (
        <Section>
          {preferences.data.map((preference) => (
            <SwitchRow
              key={preference.category}
              testID={`toggle-${preference.category}`}
              title={t(`notifications.${preference.category}`)}
              subtitle={t(`notifications.${preference.category}_hint`)}
              value={preference.pushEnabled}
              disabled={!canMutate || update.isPending}
              onValueChange={(pushEnabled) =>
                update.mutate({ category: preference.category, pushEnabled })
              }
            />
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}

/** Whether this iPhone may show notifications at all (iOS permission), with the way to fix it. */
function DevicePushSection() {
  const { t } = useTranslation('profile');
  const { status, request } = usePushPermission();
  if (status === null) return null;
  return (
    <Section title={t('notifications.device.title')}>
      <ListRow
        testID="push-permission-status"
        title={t(`notifications.device.${status}`)}
        subtitle={t(`notifications.device.${status}_hint`)}
        trailing={
          status === 'undetermined' ? (
            <Button
              testID="push-enable"
              variant="link"
              label={t('notifications.device.enable')}
              loading={request.isPending}
              onPress={() => request.mutate()}
            />
          ) : status === 'denied' ? (
            <Button
              testID="push-open-settings"
              variant="link"
              label={t('notifications.device.openSettings')}
              onPress={() => void Linking.openSettings()}
            />
          ) : undefined
        }
      />
    </Section>
  );
}
