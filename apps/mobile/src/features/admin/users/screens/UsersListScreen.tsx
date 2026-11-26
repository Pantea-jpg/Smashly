import type { UserStatus } from '@tw/contracts';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, RefreshControl, View } from 'react-native';
import { useErrorMessage } from '../../../../shared/i18n/useErrorMessage';
import { useTheme } from '../../../../shared/theme/ThemeProvider';
import { AppText } from '../../../../shared/ui/AppText';
import { Avatar } from '../../../../shared/ui/Avatar';
import { FormError } from '../../../../shared/ui/FormScreen';
import { ListRow } from '../../../../shared/ui/ListRow';
import { MoneyText } from '../../../../shared/ui/MoneyText';
import { SegmentedControl } from '../../../../shared/ui/SegmentedControl';
import { StatusPill } from '../../../../shared/ui/StatusPill';
import { TextField } from '../../../../shared/ui/TextField';
import { useAdminUsers } from '../api';
import type { UsersScreenProps } from '../navigation';

type StatusFilter = 'all' | UserStatus;
const FILTERS: readonly StatusFilter[] = ['all', 'ACTIVE', 'PENDING_APPROVAL', 'INACTIVE'];
const SEARCH_DEBOUNCE_MS = 300;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function UsersListScreen({ navigation }: UsersScreenProps<'UsersList'>) {
  const { t } = useTranslation('admin');
  const theme = useTheme();
  const errorMessage = useErrorMessage();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const q = useDebounced(search, SEARCH_DEBOUNCE_MS);
  const users = useAdminUsers({ q, status: filter === 'all' ? undefined : filter });

  const items = users.data?.pages.flatMap((page) => page.data) ?? [];
  const total = users.data?.pages[0]?.meta.page.total;

  return (
    <FlatList
      testID="users-list"
      style={{ backgroundColor: theme.colors.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md }}
      data={items}
      keyExtractor={(user) => user.id}
      refreshControl={
        <RefreshControl refreshing={users.isRefetching} onRefresh={() => void users.refetch()} />
      }
      onEndReachedThreshold={0.5}
      onEndReached={() => {
        if (users.hasNextPage && !users.isFetchingNextPage) void users.fetchNextPage();
      }}
      ListHeaderComponent={
        <View style={{ gap: theme.spacing.md }}>
          <TextField
            testID="users-search"
            label={t('users.search')}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            returnKeyType="search"
          />
          <SegmentedControl<StatusFilter>
            testID="users-filter"
            accessibilityLabel={t('users.search')}
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((value) => ({ value, label: t(`users.filters.${value}`) }))}
          />
          {total !== undefined ? (
            <AppText variant="footnote" tone="textSecondary">
              {t('users.total', { count: total })}
            </AppText>
          ) : null}
          <FormError message={errorMessage(users.error)} />
        </View>
      }
      ListEmptyComponent={
        users.isPending ? (
          <ActivityIndicator />
        ) : (
          <AppText tone="textSecondary">{t('users.empty')}</AppText>
        )
      }
      ListFooterComponent={users.isFetchingNextPage ? <ActivityIndicator /> : undefined}
      renderItem={({ item: user }) => (
        <View
          style={{
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radii.md,
            paddingHorizontal: theme.spacing.lg,
          }}
        >
          <ListRow
            testID={`user-row-${user.email}`}
            title={`${user.firstName} ${user.lastName}`.trim() || user.email}
            subtitle={user.email}
            leading={
              <Avatar url={user.avatarUrl} firstName={user.firstName} lastName={user.lastName} />
            }
            trailing={
              <View style={{ alignItems: 'flex-end', gap: theme.spacing.xxs }}>
                {user.status !== 'ACTIVE' ? <StatusPill status={user.status} /> : null}
                {user.debt && user.debt.amountMinor > 0 ? (
                  <MoneyText value={user.debt} kind="debt" variant="footnote" />
                ) : user.balance ? (
                  <MoneyText value={user.balance} variant="footnote" tone="textSecondary" />
                ) : null}
              </View>
            }
            onPress={() => navigation.navigate('UserDetail', { userId: user.id })}
          />
        </View>
      )}
    />
  );
}
