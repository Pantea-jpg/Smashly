import type { NativeStackScreenProps } from '@react-navigation/native-stack';

/** Root stack: auth screens when signed out; the role's tabs ("Main") when signed in. */
export type RootStackParamList = {
  Login: undefined;
  Register: undefined;
  ForgotPassword: undefined;
  ResetPassword: { token?: string } | undefined;
  VerifyEmail: { token?: string } | undefined;
  Main: undefined;
};

export type AuthScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<
  RootStackParamList,
  T
>;
