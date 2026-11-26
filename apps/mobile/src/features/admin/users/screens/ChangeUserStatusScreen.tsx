import { zodResolver } from '@hookform/resolvers/zod';
import { UpdateUserStatusRequestSchema } from '@tw/contracts';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useErrorMessage } from '../../../../shared/i18n/useErrorMessage';
import { AppText } from '../../../../shared/ui/AppText';
import { Button } from '../../../../shared/ui/Button';
import { Card } from '../../../../shared/ui/Card';
import { FormError } from '../../../../shared/ui/FormScreen';
import { FormTextField } from '../../../../shared/ui/FormTextField';
import { Screen } from '../../../../shared/ui/Screen';
import { useAdminUser, useUpdateUserStatus } from '../api';
import type { UsersScreenProps } from '../navigation';

const ReasonSchema = z.object({ reason: UpdateUserStatusRequestSchema.shape.reason });
type ReasonForm = z.infer<typeof ReasonSchema>;

/** Confirmation step for activating, approving or deactivating an account; a reason is required. */
export function ChangeUserStatusScreen({
  route,
  navigation,
}: UsersScreenProps<'ChangeUserStatus'>) {
  const { userId, status } = route.params;
  const { t } = useTranslation('admin');
  const { t: tc } = useTranslation('common');
  const errorMessage = useErrorMessage();
  const user = useAdminUser(userId).data;
  const update = useUpdateUserStatus(userId);
  const { control, handleSubmit } = useForm<ReasonForm>({
    resolver: zodResolver(ReasonSchema),
    defaultValues: { reason: '' },
  });

  const name = user ? `${user.firstName} ${user.lastName}`.trim() || user.email : '';
  const deactivate = status === 'INACTIVE';

  return (
    <Screen testID="change-status-screen">
      <Card>
        <AppText variant="headline">
          {t(deactivate ? 'actions.confirmDeactivateTitle' : 'actions.confirmActivateTitle', {
            name,
          })}
        </AppText>
        <AppText tone="textSecondary">
          {t(deactivate ? 'actions.confirmDeactivateBody' : 'actions.confirmActivateBody')}
        </AppText>
      </Card>
      <FormError message={errorMessage(update.error)} />
      <FormTextField control={control} name="reason" label={t('actions.reasonLabel')} multiline />
      <Button
        testID="confirm-status"
        variant={deactivate ? 'destructive' : 'primary'}
        label={tc('actions.confirm')}
        loading={update.isPending}
        onPress={() =>
          void handleSubmit(({ reason }) =>
            update.mutate({ status, reason }, { onSuccess: () => navigation.goBack() }),
          )()
        }
      />
      <Button variant="link" label={tc('actions.cancel')} onPress={() => navigation.goBack()} />
    </Screen>
  );
}
