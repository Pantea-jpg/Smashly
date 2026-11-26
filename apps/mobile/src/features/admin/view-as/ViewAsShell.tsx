import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { UserTabs } from '../../../app/navigation/UserTabs';
import { useViewAsSession } from '../../../shared/auth/viewAs';
import { useTheme } from '../../../shared/theme/ThemeProvider';
import { AppText } from '../../../shared/ui/AppText';
import { Button } from '../../../shared/ui/Button';
import { useExitViewAs } from '../users/api';

/**
 * The member app as the viewed user sees it, read-only, under a persistent banner.
 * The admin stays signed in as the admin; the server enforces read-only regardless of the UI.
 */
export function ViewAsShell() {
  const { t } = useTranslation('admin');
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const session = useViewAsSession();
  const exit = useExitViewAs();
  if (!session) return null;

  const name =
    `${session.subject.firstName} ${session.subject.lastName}`.trim() || session.subject.email;

  return (
    <View style={{ flex: 1 }}>
      <View
        testID="view-as-banner"
        accessibilityRole="summary"
        style={{
          paddingTop: insets.top + theme.spacing.xs,
          paddingBottom: theme.spacing.xs,
          paddingHorizontal: theme.spacing.lg,
          backgroundColor: theme.colors.warning,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
        }}
      >
        <AppText variant="subhead" tone="textOnAccent" style={{ flex: 1 }} numberOfLines={2}>
          {t('viewAs.banner', { name })}
        </AppText>
        <Button
          testID="exit-view-as"
          variant="secondary"
          label={t('viewAs.exit')}
          loading={exit.isPending}
          onPress={() => exit.mutate()}
        />
      </View>
      {/* The banner already covers the top inset, so nested navigators must not add it again. */}
      <SafeAreaInsetsContext.Provider value={{ ...insets, top: 0 }}>
        <UserTabs />
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}
