import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useStackScreenOptions } from '../../../app/navigation/stackOptions';
import type { UsersStackParamList } from './navigation';
import { ChangeUserStatusScreen } from './screens/ChangeUserStatusScreen';
import {
  AdjustmentScreen,
  CashPaymentScreen,
  RefundScreen,
  ReversalScreen,
  UserTransactionsScreen,
} from './screens/MoneyScreens';
import { UserDetailScreen } from './screens/UserDetailScreen';
import { UsersListScreen } from './screens/UsersListScreen';

const Stack = createNativeStackNavigator<UsersStackParamList>();

export function UsersStack() {
  const { t } = useTranslation('navigation');
  const { t: ta } = useTranslation('admin');
  const { t: tm } = useTranslation('manage');
  const screenOptions = useStackScreenOptions();
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen
        name="UsersList"
        component={UsersListScreen}
        options={{ title: t('admin.users') }}
      />
      <Stack.Screen
        name="UserDetail"
        component={UserDetailScreen}
        options={{ title: '', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="ChangeUserStatus"
        component={ChangeUserStatusScreen}
        options={{
          presentation: 'modal',
          title: ta('actions.reasonLabel'),
          headerLargeTitle: false,
        }}
      />
      <Stack.Screen
        name="CashPayment"
        component={CashPaymentScreen}
        options={{ presentation: 'modal', title: tm('money.cash'), headerLargeTitle: false }}
      />
      <Stack.Screen
        name="Adjustment"
        component={AdjustmentScreen}
        options={{ presentation: 'modal', title: tm('money.adjust'), headerLargeTitle: false }}
      />
      <Stack.Screen
        name="Refund"
        component={RefundScreen}
        options={{ presentation: 'modal', title: tm('money.refund'), headerLargeTitle: false }}
      />
      <Stack.Screen
        name="UserTransactions"
        component={UserTransactionsScreen}
        options={{ title: tm('money.transactions'), headerLargeTitle: false }}
      />
      <Stack.Screen
        name="Reversal"
        component={ReversalScreen}
        options={{ presentation: 'modal', title: tm('money.reverse'), headerLargeTitle: false }}
      />
    </Stack.Navigator>
  );
}
