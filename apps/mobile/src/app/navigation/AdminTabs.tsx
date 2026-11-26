import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useTranslation } from 'react-i18next';
import { AdminMoreStack } from '../../features/admin/more/AdminMoreStack';
import { UsersStack } from '../../features/admin/users/UsersStack';
import { AdminDashboardScreen } from '../../features/admin/dashboard/AdminDashboardScreen';
import { FinanceScreen } from '../../features/admin/finance/FinanceScreen';
import { AdminTrainingsStack } from '../../features/admin/trainings/AdminTrainingsStack';
import { tabIcon, useTabScreenOptions } from './tabOptions';
import type { AdminTabParamList } from './types';

const Tab = createBottomTabNavigator<AdminTabParamList>();

/**
 * Five tabs grouping the eight admin sections (docs/02-architecture.md §4.3):
 * Dashboard · Users · Trainings (+ Attendance) · Finance (Wallets, Transactions, Reports) · More (Settings).
 */
export function AdminTabs() {
  const { t } = useTranslation('navigation');
  const screenOptions = useTabScreenOptions();

  return (
    <Tab.Navigator screenOptions={screenOptions}>
      <Tab.Screen
        name="Dashboard"
        component={AdminDashboardScreen}
        options={{
          tabBarButtonTestID: 'tab-dashboard',
          title: t('admin.dashboard'),
          tabBarIcon: tabIcon('grid-outline'),
        }}
      />
      <Tab.Screen
        name="Users"
        component={UsersStack}
        options={{
          tabBarButtonTestID: 'tab-users',
          title: t('admin.users'),
          headerShown: false,
          tabBarIcon: tabIcon('people-outline'),
        }}
      />
      <Tab.Screen
        name="AdminTrainings"
        component={AdminTrainingsStack}
        options={{
          tabBarButtonTestID: 'tab-admin-trainings',
          title: t('admin.trainings'),
          headerShown: false,
          tabBarIcon: tabIcon('calendar-outline'),
        }}
      />
      <Tab.Screen
        name="Finance"
        component={FinanceScreen}
        options={{
          tabBarButtonTestID: 'tab-finance',
          title: t('admin.finance'),
          tabBarIcon: tabIcon('stats-chart-outline'),
        }}
      />
      <Tab.Screen
        name="More"
        component={AdminMoreStack}
        options={{
          tabBarButtonTestID: 'tab-more',
          title: t('admin.more'),
          headerShown: false,
          tabBarIcon: tabIcon('ellipsis-horizontal-circle-outline'),
        }}
      />
    </Tab.Navigator>
  );
}
