import type { UserStatus } from '@tw/contracts';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText } from './AppText';

const TONE = {
  ACTIVE: 'success',
  PENDING_APPROVAL: 'warning',
  INACTIVE: 'textSecondary',
} as const satisfies Record<UserStatus, 'success' | 'warning' | 'textSecondary'>;

/** Account status as a small labelled pill; colour is never the only signal. */
export function StatusPill({ status }: { status: UserStatus }) {
  const theme = useTheme();
  const { t } = useTranslation('admin');
  return (
    <View
      style={{
        borderRadius: theme.radii.pill,
        borderWidth: 1,
        borderColor: theme.colors[TONE[status]],
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: theme.spacing.xxs,
      }}
    >
      <AppText variant="caption" tone={TONE[status]}>
        {t(`status.${status}`)}
      </AppText>
    </View>
  );
}
