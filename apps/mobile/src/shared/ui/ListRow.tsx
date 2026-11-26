import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText } from './AppText';

interface ListRowProps {
  title: string;
  subtitle?: string | undefined;
  /** Content on the left, e.g. an Avatar. */
  leading?: ReactNode;
  /** Content on the right, e.g. a StatusPill or an amount. */
  trailing?: ReactNode;
  onPress?: () => void;
  destructive?: boolean;
  testID?: string;
}

/** iOS-style table row; shows a chevron when tappable. */
export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  destructive,
  testID,
}: ListRowProps) {
  const theme = useTheme();
  const content = (
    <View style={[styles.row, { gap: theme.spacing.md, paddingVertical: theme.spacing.md }]}>
      {leading}
      <View style={styles.text}>
        <AppText tone={destructive ? 'danger' : 'textPrimary'} numberOfLines={1}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="footnote" tone="textSecondary" numberOfLines={1}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {trailing}
      {onPress ? (
        <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
      ) : null}
    </View>
  );
  if (!onPress) return <View testID={testID}>{content}</View>;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {content}
    </Pressable>
  );
}

/** A row with an on/off switch, labelled for VoiceOver. */
export function SwitchRow({
  title,
  subtitle,
  value,
  onValueChange,
  disabled,
  testID,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { gap: theme.spacing.md, paddingVertical: theme.spacing.sm }]}>
      <View style={styles.text}>
        <AppText>{title}</AppText>
        {subtitle ? (
          <AppText variant="footnote" tone="textSecondary">
            {subtitle}
          </AppText>
        ) : null}
      </View>
      <Switch
        testID={testID}
        accessibilityLabel={title}
        value={value}
        onValueChange={onValueChange}
        disabled={disabled ?? false}
        trackColor={{ true: theme.colors.accent, false: theme.colors.separator }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  text: { flex: 1, gap: 2 },
});
