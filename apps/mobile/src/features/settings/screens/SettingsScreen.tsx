import { useMutation } from '@tanstack/react-query';
import { ProfileSchema } from '@tw/contracts';
import { type Language, SUPPORTED_LANGUAGES } from '@tw/i18n';
import { useTranslation } from 'react-i18next';
import { sessionController, useSessionStore } from '../../../shared/auth/session';
import { useCanMutate } from '../../../shared/auth/viewAs';
import { useEffectiveLanguage } from '../../../shared/i18n/I18nProvider';
import { AppText } from '../../../shared/ui/AppText';
import { Card } from '../../../shared/ui/Card';
import { Screen } from '../../../shared/ui/Screen';
import { SegmentedControl } from '../../../shared/ui/SegmentedControl';
import { type AppearancePreference, usePreferencesStore } from '../../../stores/preferences.store';

const APPEARANCES: readonly AppearancePreference[] = ['system', 'light', 'dark'];

/** Device settings (language, appearance). Language is also saved to the server profile. */
export function SettingsScreen() {
  const { t } = useTranslation('settings');
  const language = useEffectiveLanguage();
  const appearance = usePreferencesStore((s) => s.appearance);
  const setLanguage = usePreferencesStore((s) => s.setLanguage);
  const setAppearance = usePreferencesStore((s) => s.setAppearance);
  const signedIn = useSessionStore((s) => s.status === 'signedIn');
  const canMutate = useCanMutate();

  // Emails and push notifications are rendered in the profile language on the server.
  const syncLanguage = useMutation({
    mutationFn: (preferredLanguage: Language) =>
      sessionController.request({
        method: 'PATCH',
        path: '/me/profile',
        body: { preferredLanguage },
        schema: ProfileSchema,
      }),
  });

  const changeLanguage = (next: Language) => {
    setLanguage(next);
    if (signedIn && canMutate) syncLanguage.mutate(next);
  };

  return (
    <Screen testID="settings-screen">
      <Card>
        <AppText variant="headline">{t('language.title')}</AppText>
        <SegmentedControl<Language>
          testID="language"
          accessibilityLabel={t('language.title')}
          value={language}
          onChange={changeLanguage}
          options={SUPPORTED_LANGUAGES.map((code) => ({
            value: code,
            label: t(`language.${code}`),
          }))}
        />
      </Card>

      <Card>
        <AppText variant="headline">{t('appearance.title')}</AppText>
        <SegmentedControl<AppearancePreference>
          testID="appearance"
          accessibilityLabel={t('appearance.title')}
          value={appearance}
          onChange={setAppearance}
          options={APPEARANCES.map((value) => ({ value, label: t(`appearance.${value}`) }))}
        />
      </Card>
    </Screen>
  );
}
