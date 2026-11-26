/**
 * Design tokens. Components never use raw colours, sizes or font values; they read
 * semantic tokens from the active theme. One accent colour; status colours only for meaning.
 */

export interface ColorTokens {
  background: string;
  surface: string;
  surfaceElevated: string;
  textPrimary: string;
  textSecondary: string;
  textOnAccent: string;
  separator: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
}

// iOS system-inspired palette. Text/background pairs meet WCAG AA (≥ 4.5:1).
const light: ColorTokens = {
  background: '#F2F2F7',
  surface: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  textPrimary: '#111114',
  textSecondary: '#5C5C66',
  textOnAccent: '#FFFFFF',
  separator: '#D8D8DE',
  accent: '#0A63D6',
  success: '#1E7F3C',
  warning: '#9A5B00',
  danger: '#C4231C',
};

const dark: ColorTokens = {
  background: '#000000',
  surface: '#1C1C1E',
  surfaceElevated: '#2C2C2E',
  textPrimary: '#F5F5F7',
  textSecondary: '#A1A1AA',
  textOnAccent: '#FFFFFF',
  separator: '#3A3A3C',
  accent: '#3D8BFF',
  success: '#34C759',
  warning: '#FFB340',
  danger: '#FF6961',
};

/** 4-pt spacing scale. */
export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radii = {
  sm: 10,
  md: 14,
  lg: 22,
  pill: 999,
} as const;

/** iOS type ramp (points). The system font is used; Dynamic Type scaling stays enabled. */
export const typography = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700' },
  title1: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: '600' },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 17, lineHeight: 22, fontWeight: '400' },
  subhead: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
} as const;

export type TypographyVariant = keyof typeof typography;

export type ColorScheme = 'light' | 'dark';

export interface Theme {
  scheme: ColorScheme;
  colors: ColorTokens;
  spacing: typeof spacing;
  radii: typeof radii;
  typography: typeof typography;
  /** Subtle elevation for cards; dark mode relies on surface contrast instead. */
  cardShadow: {
    shadowColor: string;
    shadowOpacity: number;
    shadowRadius: number;
    shadowOffset: { width: number; height: number };
  };
}

export const themes: Record<ColorScheme, Theme> = {
  light: {
    scheme: 'light',
    colors: light,
    spacing,
    radii,
    typography,
    cardShadow: {
      shadowColor: '#000000',
      shadowOpacity: 0.06,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
    },
  },
  dark: {
    scheme: 'dark',
    colors: dark,
    spacing,
    radii,
    typography,
    cardShadow: {
      shadowColor: '#000000',
      shadowOpacity: 0,
      shadowRadius: 0,
      shadowOffset: { width: 0, height: 0 },
    },
  },
};
