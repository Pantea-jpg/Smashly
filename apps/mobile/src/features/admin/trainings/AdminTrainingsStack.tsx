import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useStackScreenOptions } from '../../../app/navigation/stackOptions';
import type { AdminTrainingsParamList } from './navigation';
import {
  AttendanceQueueScreen,
  AttendanceScreen,
  CorrectionScreen,
  PriceOverrideScreen,
  PricesScreen,
  ReservationsScreen,
} from './screens/AttendanceScreens';
import {
  AdminTrainingDetailScreen,
  AdminTrainingsListScreen,
  CancelTrainingScreen,
  TrainingFormScreen,
} from './screens/TrainingAdminScreens';

const Stack = createNativeStackNavigator<AdminTrainingsParamList>();

export function AdminTrainingsStack() {
  const { t } = useTranslation('navigation');
  const { t: tm } = useTranslation('manage');
  const screenOptions = useStackScreenOptions();
  const modal = { presentation: 'modal' as const, headerLargeTitle: false };
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen
        name="AdminTrainingsList"
        component={AdminTrainingsListScreen}
        options={{ title: t('admin.trainings') }}
      />
      <Stack.Screen
        name="AdminTrainingDetail"
        component={AdminTrainingDetailScreen}
        options={{ title: '', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="TrainingForm"
        component={TrainingFormScreen}
        options={{ ...modal, title: tm('trainings.new') }}
      />
      <Stack.Screen
        name="Reservations"
        component={ReservationsScreen}
        options={{ title: tm('trainings.actions.reservations'), headerLargeTitle: false }}
      />
      <Stack.Screen
        name="Prices"
        component={PricesScreen}
        options={{ title: tm('trainings.actions.prices'), headerLargeTitle: false }}
      />
      <Stack.Screen
        name="PriceOverride"
        component={PriceOverrideScreen}
        options={{ ...modal, title: tm('trainings.actions.prices') }}
      />
      <Stack.Screen
        name="Attendance"
        component={AttendanceScreen}
        options={{ title: tm('trainings.actions.attendance'), headerLargeTitle: false }}
      />
      <Stack.Screen
        name="Correction"
        component={CorrectionScreen}
        options={{ ...modal, title: tm('attendance.correct') }}
      />
      <Stack.Screen
        name="CancelTraining"
        component={CancelTrainingScreen}
        options={{ ...modal, title: tm('trainings.actions.cancel') }}
      />
      <Stack.Screen
        name="AttendanceQueue"
        component={AttendanceQueueScreen}
        options={{ title: tm('attendance.queueTitle'), headerLargeTitle: false }}
      />
    </Stack.Navigator>
  );
}
