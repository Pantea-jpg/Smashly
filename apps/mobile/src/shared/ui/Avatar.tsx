import { Image, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText } from './AppText';

function initials(firstName: string, lastName: string): string {
  const letters = `${firstName.trim().charAt(0)}${lastName.trim().charAt(0)}`;
  return letters.toUpperCase() || '?';
}

/** Profile picture, or initials on a tinted circle when there is none. */
export function Avatar({
  url,
  firstName,
  lastName,
  size = 44,
}: {
  url: string | null;
  firstName: string;
  lastName: string;
  size?: number;
}) {
  const theme = useTheme();
  const shape = { width: size, height: size, borderRadius: size / 2 };
  if (url) {
    return (
      <Image
        source={{ uri: url }}
        style={shape}
        accessibilityIgnoresInvertColors
        accessible={false}
      />
    );
  }
  return (
    <View
      accessible={false}
      style={[
        shape,
        {
          backgroundColor: theme.colors.background,
          alignItems: 'center',
          justifyContent: 'center',
        },
      ]}
    >
      <AppText variant={size >= 64 ? 'title2' : 'headline'} tone="accent">
        {initials(firstName, lastName)}
      </AppText>
    </View>
  );
}
