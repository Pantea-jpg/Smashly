import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AdminUserDetailSchema,
  AdminUserListItemSchema,
  offsetListEnvelope,
  type UpdateUserStatusRequest,
  type UserStatus,
  ViewSessionSchema,
} from '@tw/contracts';
import { queryKeys } from '../../../shared/api/queryKeys';
import { sessionController } from '../../../shared/auth/session';
import { useViewAsStore } from '../../../shared/auth/viewAs';

const PAGE_SIZE = 25;
const UserPageSchema = offsetListEnvelope(AdminUserListItemSchema);

export interface UserFilters {
  q: string;
  status: UserStatus | undefined;
}

export function useAdminUsers(filters: UserFilters) {
  return useInfiniteQuery({
    queryKey: queryKeys.adminUsers(filters),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ page: String(pageParam), pageSize: String(PAGE_SIZE) });
      if (filters.q.trim()) params.set('q', filters.q.trim());
      if (filters.status) params.set('status', filters.status);
      return sessionController.request({
        method: 'GET',
        path: `/admin/users?${params.toString()}`,
        schema: UserPageSchema,
        envelope: 'full',
      });
    },
    getNextPageParam: (last) => {
      const { page, pageSize, total } = last.meta.page;
      return page * pageSize < total ? page + 1 : undefined;
    },
  });
}

export function useAdminUser(userId: string) {
  return useQuery({
    queryKey: queryKeys.adminUser(userId),
    queryFn: () =>
      sessionController.request({
        method: 'GET',
        path: `/admin/users/${userId}`,
        schema: AdminUserDetailSchema,
      }),
  });
}

export function useUpdateUserStatus(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateUserStatusRequest) =>
      sessionController.request({
        method: 'PATCH',
        path: `/admin/users/${userId}/status`,
        body: input,
        schema: AdminUserDetailSchema,
      }),
    onSuccess: (user) => {
      queryClient.setQueryData(queryKeys.adminUser(userId), user);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
}

/** Starts View as User: from now on GET requests carry the view-session header. */
export function useStartViewAs() {
  return useMutation({
    mutationFn: (userId: string) =>
      sessionController.request({
        method: 'POST',
        path: '/admin/view-sessions',
        body: { userId },
        schema: ViewSessionSchema,
      }),
    onSuccess: (session) => useViewAsStore.getState().setSession(session),
  });
}

/** Ends View as User and drops everything cached for the viewed user. */
export function useExitViewAs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const session = useViewAsStore.getState().session;
      if (!session) return;
      try {
        // Sent as the admin, without the view-session header.
        await sessionController.request({
          method: 'DELETE',
          path: `/admin/view-sessions/${session.id}`,
          ignoreViewAs: true,
        });
      } finally {
        useViewAsStore.getState().setSession(null);
        queryClient.removeQueries({ queryKey: queryKeys.subject(session.subject.id) });
      }
    },
  });
}
