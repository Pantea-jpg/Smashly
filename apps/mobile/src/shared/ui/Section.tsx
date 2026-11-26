import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText } from './AppText';

/** Grouped list section: small caps title above a rounded card of rows with separators. */
export function Section({ title, children }: { title?: string; children: ReactNode }) {
  const theme = useTheme();
  const rows = (Array.isArray(children) ? children : [children]).filter(Boolean) as ReactNode[];
  return (
    <View style={{ gap: theme.spacing.xs }}>
      {title ? (
        <AppText
          variant="footnote"
          tone="textSecondary"
          accessibilityRole="header"
          style={{ paddingHorizontal: theme.spacing.lg, textTransform: 'uppercase' }}
        >
          {title}
        </AppText>
      ) : null}
      <View
        style={{
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radii.md,
          paddingHorizontal: theme.spacing.lg,
        }}
      >
        {rows.map((row, index) => (
          <View
            key={index}
            style={
              index > 0 ? { borderTopWidth: 1, borderTopColor: theme.colors.separator } : undefined
            }
          >
            {row}
          </View>
        ))}
      </View>
    </View>
  );
}
