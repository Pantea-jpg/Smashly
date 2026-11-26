import {
  DarkTheme,
  DefaultTheme,
  type LinkingOptions,
  NavigationContainer,
  type Theme as NavTheme,
  useNavigation,
} from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { useMemo } from 'react';
import type { RootStackParamList } from '../../features/auth/navigation';
import { ForgotPasswordScreen } from '../../features/auth/screens/ForgotPasswordScreen';
import { LoginScreen } from '../../features/auth/screens/LoginScreen';
import { RegisterScreen } from '../../features/auth/screens/RegisterScreen';
import { ResetPasswordScreen } from '../../features/auth/screens/ResetPasswordScreen';
import { VerifyEmailScreen } from '../../features/auth/screens/VerifyEmailScreen';
import { ViewAsShell } from '../../features/admin/view-as/ViewAsShell';
import { useSessionStore } from '../../shared/auth/session';
import { APP_LINK_PREFIX } from '../../shared/config/appScheme';
import type { PushRoute } from '../../shared/push/push';
import { usePushLifecycle } from '../../shared/push/usePush';
import { useRealtime } from '../../shared/realtime/useRealtime';
import { useViewAsSession } from '../../shared/auth/viewAs';
import { useTheme } from '../../shared/theme/ThemeProvider';
import { AdminTabs } from './AdminTabs';
import { UserTabs } from './UserTabs';

const Stack = createNativeStackNavigator<RootStackParamList>();
type VerifyEmailProps = NativeStackScreenProps<RootStackParamList, 'VerifyEmail'>;

/** Email links open the app: <scheme>://reset-password?token=… and …/verify-email?token=… */
export const linking: LinkingOptions<RootStackParamList> = {
  prefixes: [APP_LINK_PREFIX],
  config: {
    screens: {
      ResetPassword: 'reset-password',
      VerifyEmail: 'verify-email',
    },
  },
};

/** The nested navigation action that shows what a tapped push is about. */
export function pushDestination(
  route: PushRoute,
  role: 'ADMIN' | 'USER' | undefined,
): { screen: string; params?: object } {
  if (role === 'ADMIN') {
    if (route.kind === 'finalize') {
      return {
        screen: 'AdminTrainings',
        params: route.trainingId
          ? { screen: 'Attendance', params: { trainingId: route.trainingId }, initial: false }
          : { screen: 'AttendanceQueue', initial: false },
      };
    }
    return { screen: 'Dashboard' };
  }
  switch (route.kind) {
    case 'training':
      return {
        screen: 'Trainings',
        params: {
          screen: 'TrainingDetail',
          params: { trainingId: route.trainingId },
          initial: false,
        },
      };
    case 'transaction':
      return {
        screen: 'Wallet',
        params: {
          screen: 'TransactionDetail',
          params: { transactionId: route.transactionId },
          initial: false,
        },
      };
    case 'payment':
      return { screen: 'Wallet', params: { screen: 'WalletHome' } };
    case 'finalize': // admin-only; not expected for members
    case 'inbox':
      return { screen: 'Notifications' };
  }
}

function MainTabs() {
  const role = useSessionStore((s) => s.user?.role);
  const viewing = useViewAsSession();
  const navigation = useNavigation();
  useRealtime();
  usePushLifecycle((route) => {
    // Tab navigators are nested in "Main"; the target is resolved per role.
    (navigation.navigate as (name: string, params: object) => void)(
      'Main',
      pushDestination(route, role),
    );
  });
  // Navigation follows the server-confirmed role; the API enforces authorization regardless.
  if (role === 'ADMIN') return viewing ? <ViewAsShell /> : <AdminTabs />;
  return <UserTabs />;
}

export function RootNavigator() {
  const theme = useTheme();
  const status = useSessionStore((s) => s.status);

  const navigationTheme = useMemo<NavTheme>(() => {
    const base = theme.scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: theme.colors.accent,
        background: theme.colors.background,
        card: theme.colors.surface,
        text: theme.colors.textPrimary,
        border: theme.colors.separator,
        notification: theme.colors.danger,
      },
    };
  }, [theme]);

  // While the stored session is being restored the native splash screen stays visible.
  if (status === 'restoring') return null;

  return (
    <NavigationContainer theme={navigationTheme} linking={linking}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {status === 'signedIn' ? (
          <>
            <Stack.Screen name="Main" component={MainTabs} />
            <Stack.Screen name="VerifyEmail" options={{ presentation: 'modal' }}>
              {({ route, navigation }: VerifyEmailProps) => (
                <VerifyEmailScreen token={route.params?.token} onDone={() => navigation.goBack()} />
              )}
            </Stack.Screen>
          </>
        ) : (
          <>
            <Stack.Screen name="Login" component={LoginScreen} />
            <Stack.Screen name="Register" component={RegisterScreen} />
            <Stack.Screen name="ForgotPassword" component={ForgotPasswordScreen} />
            <Stack.Screen name="ResetPassword" component={ResetPasswordScreen} />
            <Stack.Screen name="VerifyEmail">
              {({ route, navigation }: VerifyEmailProps) => (
                <VerifyEmailScreen
                  token={route.params?.token}
                  onDone={() => navigation.navigate('Login')}
                />
              )}
            </Stack.Screen>
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
