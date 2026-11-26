import type { CompositeScreenProps, NavigatorScreenParams } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type MemberTrainingsParamList = {
  TrainingsList: undefined;
  TrainingDetail: { trainingId: string };
};

export type WalletParamList = {
  WalletHome: undefined;
  TransactionDetail: { transactionId: string };
  TopUp: undefined;
};

export type MemberTabParamList = {
  Home: undefined;
  Trainings: NavigatorScreenParams<MemberTrainingsParamList> | undefined;
  Wallet: NavigatorScreenParams<WalletParamList> | undefined;
  Notifications: undefined;
  Profile: undefined;
};

export type HomeScreenProps = BottomTabScreenProps<MemberTabParamList, 'Home'>;

export type TrainingsScreenProps<T extends keyof MemberTrainingsParamList> = CompositeScreenProps<
  NativeStackScreenProps<MemberTrainingsParamList, T>,
  BottomTabScreenProps<MemberTabParamList>
>;

export type WalletScreenProps<T extends keyof WalletParamList> = CompositeScreenProps<
  NativeStackScreenProps<WalletParamList, T>,
  BottomTabScreenProps<MemberTabParamList>
>;
