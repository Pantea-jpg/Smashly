import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useStackScreenOptions } from '../../app/navigation/stackOptions';
import type { MemberTrainingsParamList, WalletParamList } from './navigation';
import { TopUpScreen } from './screens/TopUpScreen';
import { TrainingDetailScreen, TrainingsListScreen } from './screens/TrainingScreens';
import { TransactionDetailScreen, WalletScreen } from './screens/WalletScreens';

const TrainingsNav = createNativeStackNavigator<MemberTrainingsParamList>();
const WalletNav = createNativeStackNavigator<WalletParamList>();

export function MemberTrainingsStack() {
  const { t } = useTranslation('navigation');
  const screenOptions = useStackScreenOptions();
  return (
    <TrainingsNav.Navigator screenOptions={screenOptions}>
      <TrainingsNav.Screen
        name="TrainingsList"
        component={TrainingsListScreen}
        options={{ title: t('user.trainings') }}
      />
      <TrainingsNav.Screen
        name="TrainingDetail"
        component={TrainingDetailScreen}
        options={{ title: '', headerLargeTitle: false }}
      />
    </TrainingsNav.Navigator>
  );
}

export function WalletStack() {
  const { t } = useTranslation('navigation');
  const { t: tm } = useTranslation('member');
  const screenOptions = useStackScreenOptions();
  return (
    <WalletNav.Navigator screenOptions={screenOptions}>
      <WalletNav.Screen
        name="WalletHome"
        component={WalletScreen}
        options={{ title: t('user.wallet') }}
      />
      <WalletNav.Screen
        name="TransactionDetail"
        component={TransactionDetailScreen}
        options={{ title: '', headerLargeTitle: false }}
      />
      <WalletNav.Screen
        name="TopUp"
        component={TopUpScreen}
        options={{ title: tm('topUp.title'), headerLargeTitle: false }}
      />
    </WalletNav.Navigator>
  );
}
