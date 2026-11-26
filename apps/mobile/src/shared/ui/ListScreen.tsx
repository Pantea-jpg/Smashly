import type { ReactElement, ReactNode } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { EmptyState, ErrorState, Skeleton } from './States';

interface ListScreenProps<T> {
  testID?: string;
  data: T[];
  keyExtractor: (item: T) => string;
  renderItem: (item: T) => ReactElement;
  /** Content above the list (cards, filters). Scrolls with the list. */
  header?: ReactNode;
  /** Content below the items (actions such as Save). Shown once the list has loaded. */
  footer?: ReactNode;
  isPending: boolean;
  error: unknown;
  emptyMessage: string;
  onRefresh: () => unknown;
  refreshing: boolean;
  onEndReached?: () => unknown;
}

/**
 * A long, paginated list: pull to refresh, infinite scroll, and the loading (skeleton),
 * error (retry) and empty states handled in one place.
 */
export function ListScreen<T>({
  testID,
  data,
  keyExtractor,
  renderItem,
  header,
  footer: actions,
  isPending,
  error,
  emptyMessage,
  onRefresh,
  refreshing,
  onEndReached,
}: ListScreenProps<T>) {
  const theme = useTheme();
  const footer = isPending ? (
    <Skeleton rows={4} />
  ) : error && data.length === 0 ? (
    <ErrorState error={error} onRetry={() => void onRefresh()} />
  ) : data.length === 0 ? (
    <EmptyState message={emptyMessage} />
  ) : actions ? (
    <View style={{ gap: theme.spacing.md, marginTop: theme.spacing.lg }}>{actions}</View>
  ) : undefined;
  return (
    <FlatList
      testID={testID}
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}
      contentInsetAdjustmentBehavior="automatic"
      data={data}
      keyExtractor={keyExtractor}
      renderItem={({ item }) => (
        <View
          style={{
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radii.sm,
            paddingHorizontal: theme.spacing.md,
          }}
        >
          {renderItem(item)}
        </View>
      )}
      ListHeaderComponent={
        header ? (
          <View style={{ gap: theme.spacing.lg, marginBottom: theme.spacing.sm }}>{header}</View>
        ) : undefined
      }
      ListFooterComponent={footer ?? undefined}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      // Phase 9 tuning for long histories (a page is 20 rows): render the first screenful
      // right away, then add rows in small batches and keep ~4 screens mounted instead of 21.
      initialNumToRender={12}
      maxToRenderPerBatch={10}
      windowSize={9}
      onEndReachedThreshold={0.4}
      {...(onEndReached ? { onEndReached: () => void onEndReached() } : {})}
    />
  );
}
