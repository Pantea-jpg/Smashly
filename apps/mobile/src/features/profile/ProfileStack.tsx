import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useStackScreenOptions } from '../../app/navigation/stackOptions';
import { SettingsScreen } from '../settings/screens/SettingsScreen';
import type { ProfileStackParamList } from './navigation';
import { ChangePasswordScreen } from './screens/ChangePasswordScreen';
import { DeleteAccountScreen } from './screens/DeleteAccountScreen';
import { EditProfileScreen } from './screens/EditProfileScreen';
import { NotificationSettingsScreen } from './screens/NotificationSettingsScreen';
import { ProfileScreen } from './screens/ProfileScreen';

const Stack = createNativeStackNavigator<ProfileStackParamList>();

export function ProfileStack() {
  const { t } = useTranslation('profile');
  const { t: tn } = useTranslation('navigation');
  const { t: ts } = useTranslation('settings');
  const screenOptions = useStackScreenOptions();
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen
        name="ProfileHome"
        component={ProfileScreen}
        options={{ title: tn('user.profile') }}
      />
      <Stack.Screen
        name="EditProfile"
        component={EditProfileScreen}
        options={{ title: t('edit.title') }}
      />
      <Stack.Screen
        name="ChangePassword"
        component={ChangePasswordScreen}
        options={{ title: t('password.title') }}
      />
      <Stack.Screen
        name="NotificationSettings"
        component={NotificationSettingsScreen}
        options={{ title: t('notifications.title') }}
      />
      <Stack.Screen
        name="AppSettings"
        component={SettingsScreen}
        options={{ title: ts('title') }}
      />
      <Stack.Screen
        name="DeleteAccount"
        component={DeleteAccountScreen}
        options={{ title: t('delete.title') }}
      />
    </Stack.Navigator>
  );
}
