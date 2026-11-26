import type { AdminSettings } from '@tw/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hapticSuccess } from '../../../shared/feedback/feedback';
import { minorToInput, parseAmountToMinor } from '../../../shared/format/amount';
import { useErrorMessage } from '../../../shared/i18n/useErrorMessage';
import { AppText } from '../../../shared/ui/AppText';
import { Button } from '../../../shared/ui/Button';
import { FormError } from '../../../shared/ui/FormScreen';
import { SwitchRow } from '../../../shared/ui/ListRow';
import { Screen } from '../../../shared/ui/Screen';
import { Section } from '../../../shared/ui/Section';
import { Banner, ErrorState, Skeleton } from '../../../shared/ui/States';
import { TextField } from '../../../shared/ui/TextField';
import { useAdminSettings, useUpdateSettings } from '../api';

/** "HH:MM", 24-hour clock (matches the API's ClockTimeSchema). */
const CLOCK_TIME = /^([01]d|2[0-3]):[0-5]d$/;

export function BusinessSettingsScreen() {
  const settings = useAdminSettings();
  if (settings.isPending) {
    return (
      <Screen>
        <Skeleton rows={4} />
      </Screen>
    );
  }
  if (!settings.data) {
    return (
      <Screen>
        <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
      </Screen>
    );
  }
  return <SettingsForm initial={settings.data} />;
}

function SettingsForm({ initial }: { initial: AdminSettings }) {
  const { t } = useTranslation('manage');
  const { t: tc } = useTranslation('common');
  const errorMessage = useErrorMessage();
  const update = useUpdateSettings();
  const [saved, setSaved] = useState(false);
  const [f, setF] = useState({
    topUpMin: minorToInput(initial.topUpMinMinor),
    topUpMax: minorToInput(initial.topUpMaxMinor),
    maxBalance: minorToInput(initial.maxBalanceMinor),
    lowBalance: minorToInput(initial.lowBalanceThresholdMinor),
    debtBlock:
      initial.reservationDebtBlockMinor === null
        ? ''
        : minorToInput(initial.reservationDebtBlockMinor),
    approval: initial.registrationRequiresApproval,
    quiet: initial.quietHours !== null,
    quietStart: initial.quietHours?.start ?? '22:00',
    quietEnd: initial.quietHours?.end ?? '08:00',
  });
  const set = (key: Exclude<keyof typeof f, 'approval' | 'quiet'>) => (value: string) => {
    setSaved(false);
    setF((prev) => ({ ...prev, [key]: value }));
  };
  const parsed = {
    topUpMinMinor: parseAmountToMinor(f.topUpMin),
    topUpMaxMinor: parseAmountToMinor(f.topUpMax),
    maxBalanceMinor: parseAmountToMinor(f.maxBalance),
    lowBalanceThresholdMinor: parseAmountToMinor(f.lowBalance),
  };
  const debtBlock = f.debtBlock.trim() === '' ? null : parseAmountToMinor(f.debtBlock);
  const quietValid =
    !f.quiet ||
    (CLOCK_TIME.test(f.quietStart) && CLOCK_TIME.test(f.quietEnd) && f.quietStart !== f.quietEnd);
  const valid =
    quietValid &&
    Object.values(parsed).every((v) => v !== null) &&
    (f.debtBlock.trim() === '' || debtBlock !== null) &&
    (parsed.topUpMinMinor ?? 0) <= (parsed.topUpMaxMinor ?? 0);

  const save = () =>
    update.mutate(
      {
        topUpMinMinor: parsed.topUpMinMinor!,
        topUpMaxMinor: parsed.topUpMaxMinor!,
        maxBalanceMinor: parsed.maxBalanceMinor!,
        lowBalanceThresholdMinor: parsed.lowBalanceThresholdMinor!,
        reservationDebtBlockMinor: debtBlock,
        registrationRequiresApproval: f.approval,
        quietHours: f.quiet ? { start: f.quietStart, end: f.quietEnd } : null,
      },
      {
        onSuccess: () => {
          hapticSuccess();
          setSaved(true);
        },
      },
    );

  return (
    <Screen testID="business-settings">
      {saved ? (
        <Banner testID="settings-saved" tone="success" message={t('settings.saved')} />
      ) : null}
      <TextField
        testID="set-top-up-min"
        label={t('settings.topUpMin')}
        value={f.topUpMin}
        onChangeText={set('topUpMin')}
        keyboardType="decimal-pad"
      />
      <TextField
        testID="set-top-up-max"
        label={t('settings.topUpMax')}
        value={f.topUpMax}
        onChangeText={set('topUpMax')}
        keyboardType="decimal-pad"
      />
      <TextField
        testID="set-max-balance"
        label={t('settings.maxBalance')}
        value={f.maxBalance}
        onChangeText={set('maxBalance')}
        keyboardType="decimal-pad"
      />
      <TextField
        testID="set-low-balance"
        label={t('settings.lowBalance')}
        value={f.lowBalance}
        onChangeText={set('lowBalance')}
        keyboardType="decimal-pad"
      />
      <TextField
        testID="set-debt-block"
        label={t('settings.debtBlock')}
        value={f.debtBlock}
        onChangeText={set('debtBlock')}
        keyboardType="decimal-pad"
      />
      <Section>
        <SwitchRow
          testID="set-approval"
          title={t('settings.approval')}
          value={f.approval}
          onValueChange={(approval) => {
            setSaved(false);
            setF((prev) => ({ ...prev, approval }));
          }}
        />
      </Section>
      <Section title={t('settings.quietHours')}>
        <SwitchRow
          testID="set-quiet"
          title={t('settings.quietHoursOn')}
          value={f.quiet}
          onValueChange={(quiet) => {
            setSaved(false);
            setF((prev) => ({ ...prev, quiet }));
          }}
        />
      </Section>
      <AppText variant="footnote" tone="textSecondary">
        {t('settings.quietHoursHint')}
      </AppText>
      {f.quiet ? (
        <>
          <TextField
            testID="set-quiet-start"
            label={t('settings.quietStart')}
            value={f.quietStart}
            onChangeText={set('quietStart')}
            placeholder="22:00"
            keyboardType="numbers-and-punctuation"
          />
          <TextField
            testID="set-quiet-end"
            label={t('settings.quietEnd')}
            value={f.quietEnd}
            onChangeText={set('quietEnd')}
            placeholder="08:00"
            keyboardType="numbers-and-punctuation"
          />
        </>
      ) : null}
      <FormError message={errorMessage(update.error)} />
      <Button
        testID="save-settings"
        label={tc('actions.save')}
        disabled={!valid}
        loading={update.isPending}
        onPress={save}
      />
    </Screen>
  );
}
