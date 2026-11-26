import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type UsersStackParamList = {
  UsersList: undefined;
  UserDetail: { userId: string };
  ChangeUserStatus: { userId: string; status: 'ACTIVE' | 'INACTIVE' };
  CashPayment: { userId: string; name: string };
  Adjustment: { userId: string; name: string };
  Refund: { userId: string; name: string };
  UserTransactions: { userId: string };
  Reversal: { userId: string; transactionId: string; title: string };
};

export type UsersScreenProps<T extends keyof UsersStackParamList> = NativeStackScreenProps<
  UsersStackParamList,
  T
>;
