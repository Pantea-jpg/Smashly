import { useNavigation } from '@react-navigation/native';
import { useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useCanMutate } from '../../../shared/auth/viewAs';
import { useRefreshOnFocus } from '../../../shared/feedback/feedback';
import { useFormatDate } from '../../../shared/format/date';
import { useTheme } from '../../../shared/theme/ThemeProvider';
import { AppText } from '../../../shared/ui/AppText';
import { Button } from '../../../shared/ui/Button';
import { ListScreen } from '../../../shared/ui/ListScreen';
import { useMarkAllRead, useNotifications, useUnreadCount } from '../api';
import { useNotificationText } from '../format';

export function NotificationsScreen() {
  const { t } = useTranslation('member');
  const theme = useTheme();
  const navigation = useNavigation();
  const canMutate = useCanMutate();
  const { dateTime } = useFormatDate();
  const text = useNotificationText();
  const query = useNotifications();
  const unread = useUnreadCount();
  const markAll = useMarkAllRead();
  useRefreshOnFocus(query.refetch);
  const items = query.data?.pages.flatMap((p) => p.data) ?? [];
  const hasUnread = (unread.data?.unread ?? 0) > 0;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight:
        canMutate && hasUnread
          ? () => (
              <Button
                testID="mark-all-read"
                variant="link"
                label={t('notifications.markAllRead')}
                loading={markAll.isPending}
                onPress={() => markAll.mutate()}
              />
            )
          : undefined,
    });
  }, [navigation, canMutate, hasUnread, markAll, t]);

  return (
    <ListScreen
      testID="notifications-screen"
      data={items}
      keyExtractor={(n) => n.id}
      isPending={query.isPending}
      error={query.error}
      emptyMessage={t('notifications.empty')}
      refreshing={query.isRefetching && !query.isFetchingNextPage}
      onRefresh={() => Promise.all([query.refetch(), unread.refetch()])}
      onEndReached={() =>
        query.hasNextPage && !query.isFetchingNextPage ? query.fetchNextPage() : undefined
      }
      renderItem={(n) => {
        const { title, body } = text(n);
        return (
          <View
            testID={`notification-${n.id}`}
            accessible
            accessibilityLabel={`${n.readAt ? '' : '• '}${title}. ${body}`}
            style={{
              flexDirection: 'row',
              gap: theme.spacing.sm,
              paddingVertical: theme.spacing.md,
            }}
          >
            <View
              style={{
                width: 8,
                height: 8,
                marginTop: 7,
                borderRadius: 4,
                backgroundColor: n.readAt ? 'transparent' : theme.colors.accent,
              }}
            />
            <View style={{ flex: 1, gap: theme.spacing.xxs }}>
              <AppText variant="headline">{title}</AppText>
              <AppText variant="subhead">{body}</AppText>
              <AppText variant="caption" tone="textSecondary">
                {dateTime(n.createdAt)}
              </AppText>
            </View>
          </View>
        );
      }}
    />
  );
}
