import { Text, type TextProps } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import type { ColorTokens, TypographyVariant } from '../theme/tokens';

type Tone = keyof Pick<
  ColorTokens,
  'textPrimary' | 'textSecondary' | 'textOnAccent' | 'accent' | 'success' | 'warning' | 'danger'
>;

export interface AppTextProps extends TextProps {
  variant?: TypographyVariant;
  tone?: Tone;
}

/** The only text component screens should use: themed, typed, Dynamic Type enabled. */
export function AppText({ variant = 'body', tone = 'textPrimary', style, ...rest }: AppTextProps) {
  const theme = useTheme();
  return (
    <Text
      allowFontScaling
      maxFontSizeMultiplier={1.8}
      style={[theme.typography[variant], { color: theme.colors[tone] }, style]}
      {...rest}
    />
  );
}
