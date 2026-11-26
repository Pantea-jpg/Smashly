import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useTranslation } from 'react-i18next';
import { useUnreadCount } from '../../features/member/api';
import type { MemberTabParamList } from '../../features/member/navigation';
import { HomeScreen } from '../../features/member/screens/HomeScreen';
import { NotificationsScreen } from '../../features/member/screens/NotificationsScreen';
import { MemberTrainingsStack, WalletStack } from '../../features/member/stacks';
import { ProfileStack } from '../../features/profile/ProfileStack';
import { useViewAsSession } from '../../shared/auth/viewAs';
import { useBadgeCount } from '../../shared/push/usePush';
import { tabIcon, useTabScreenOptions } from './tabOptions';

const Tab = createBottomTabNavigator<MemberTabParamList>();

/** The member app. Also rendered, read-only, when an admin views the app as a user. */
export function UserTabs() {
  const { t } = useTranslation('navigation');
  const screenOptions = useTabScreenOptions();
  const unreadData = useUnreadCount().data?.unread;
  const unread = unreadData ?? 0;
  const viewing = useViewAsSession() !== null;
  // The app icon badge is the signed-in member's own count, never a viewed member's.
  useBadgeCount(viewing ? undefined : unreadData);

  return (
    <Tab.Navigator screenOptions={screenOptions}>
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarButtonTestID: 'tab-home',
          title: t('user.home'),
          tabBarIcon: tabIcon('home-outline'),
        }}
      />
      <Tab.Screen
        name="Trainings"
        component={MemberTrainingsStack}
        options={{
          tabBarButtonTestID: 'tab-trainings',
          title: t('user.trainings'),
          headerShown: false,
          tabBarIcon: tabIcon('barbell-outline'),
        }}
      />
      <Tab.Screen
        name="Wallet"
        component={WalletStack}
        options={{
          tabBarButtonTestID: 'tab-wallet',
          title: t('user.wallet'),
          headerShown: false,
          tabBarIcon: tabIcon('wallet-outline'),
        }}
      />
      <Tab.Screen
        name="Notifications"
        component={NotificationsScreen}
        options={{
          tabBarButtonTestID: 'tab-notifications',
          title: t('user.notifications'),
          tabBarIcon: tabIcon('notifications-outline'),
          ...(unread > 0 ? { tabBarBadge: unread > 99 ? '99+' : unread } : {}),
        }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileStack}
        options={{
          tabBarButtonTestID: 'tab-profile',
          title: t('user.profile'),
          headerShown: false,
          tabBarIcon: tabIcon('person-circle-outline'),
        }}
      />
    </Tab.Navigator>
  );
}
