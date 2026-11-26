import { useMutation } from '@tanstack/react-query';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useStackScreenOptions } from '../../../app/navigation/stackOptions';
import { sessionController, useSessionUser } from '../../../shared/auth/session';
import { Button } from '../../../shared/ui/Button';
import { ListRow } from '../../../shared/ui/ListRow';
import { Screen } from '../../../shared/ui/Screen';
import { Section } from '../../../shared/ui/Section';
import { SettingsScreen } from '../../settings/screens/SettingsScreen';
import { BusinessSettingsScreen } from './BusinessSettingsScreen';

type MoreStackParamList = {
  MoreHome: undefined;
  AppSettings: undefined;
  BusinessSettings: undefined;
};

function AdminMoreScreen({ navigation }: NativeStackScreenProps<MoreStackParamList, 'MoreHome'>) {
  const { t: tc } = useTranslation('common');
  const { t: ts } = useTranslation('settings');
  const { t: tm } = useTranslation('manage');
  const user = useSessionUser();
  const signOut = useMutation({ mutationFn: () => sessionController.logout() });
  return (
    <Screen testID="admin-more-screen">
      {user ? (
        <Section title={ts('account.title')}>
          <ListRow title={`${user.firstName} ${user.lastName}`.trim()} subtitle={user.email} />
        </Section>
      ) : null}
      <Section>
        <ListRow
          testID="row-queue"
          title={tm('more.queue')}
          onPress={() =>
            navigation
              .getParent()
              ?.navigate('AdminTrainings', { screen: 'AttendanceQueue', initial: false })
          }
        />
        <ListRow
          testID="row-business-settings"
          title={tm('more.businessSettings')}
          onPress={() => navigation.navigate('BusinessSettings')}
        />
      </Section>
      <Section>
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
    </Screen>
  );
}

const Stack = createNativeStackNavigator<MoreStackParamList>();

export function AdminMoreStack() {
  const { t } = useTranslation('navigation');
  const { t: ts } = useTranslation('settings');
  const { t: tm } = useTranslation('manage');
  const screenOptions = useStackScreenOptions();
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen
        name="MoreHome"
        component={AdminMoreScreen}
        options={{ title: t('admin.more') }}
      />
      <Stack.Screen
        name="AppSettings"
        component={SettingsScreen}
        options={{ title: ts('title') }}
      />
      <Stack.Screen
        name="BusinessSettings"
        component={BusinessSettingsScreen}
        options={{ title: tm('settings.title'), headerLargeTitle: false }}
      />
    </Stack.Navigator>
  );
}
