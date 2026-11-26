import type { NavigatorScreenParams } from '@react-navigation/native';
import type { AdminTrainingsParamList } from '../../features/admin/trainings/navigation';
import type { UsersStackParamList } from '../../features/admin/users/navigation';

/** Member tabs: see MemberTabParamList in features/member/navigation.ts. */

export type AdminTabParamList = {
  Dashboard: undefined;
  Users: NavigatorScreenParams<UsersStackParamList> | undefined;
  AdminTrainings: NavigatorScreenParams<AdminTrainingsParamList> | undefined;
  Finance: undefined;
  More: undefined;
};
