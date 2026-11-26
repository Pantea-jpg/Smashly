import type {
  AdminUserDetail,
  AdminUserListItem,
  AdminUserListQuery,
  UpdateUserStatusRequest,
} from '@tw/contracts';
import { DEFAULT_CURRENCY, isCurrencyCode } from '@tw/money';
import { writeAudit } from '../../core/audit/audit';
import type { Actor, AuditContext } from '../../core/context/request-context';
import { type Prisma, type PrismaClient } from '../../core/db/prisma';
import { AppError } from '../../core/errors/app-error';
import { enqueueOutbox } from '../../core/outbox/outbox';
import type { ObjectStorage } from '../../integrations/storage/object-storage';
import { toLanguage } from '../auth/auth.service';
import { avatarUrl } from './avatar';

const MAX_SEARCH_TERMS = 5;

const USER_ROW_SELECT = {
  id: true,
  email: true,
  role: true,
  status: true,
  emailVerifiedAt: true,
  createdAt: true,
  lastLoginAt: true,
  deletedAt: true,
  profile: {
    select: {
      firstName: true,
      lastName: true,
      phone: true,
      avatarKey: true,
      preferredLanguage: true,
    },
  },
  wallets: {
    where: { currency: DEFAULT_CURRENCY },
    select: { currency: true, balanceMinor: true, debtMinor: true },
  },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_ROW_SELECT }>;

/**
 * Builds the search filter: every term must match the email, first or last name
 * (case-insensitive substring; served by the pg_trgm GIN indexes).
 * "anna vries" finds "Anna de Vries".
 */
export function userSearchFilter(q: string | undefined): Prisma.UserWhereInput[] {
  const terms = (q ?? '').split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);
  return terms.map((term) => ({
    OR: [
      { email: { contains: term, mode: 'insensitive' } },
      { profile: { firstName: { contains: term, mode: 'insensitive' } } },
      { profile: { lastName: { contains: term, mode: 'insensitive' } } },
    ],
  }));
}

function orderBy(sort: AdminUserListQuery['sort']): Prisma.UserOrderByWithRelationInput[] {
  const order: Prisma.UserOrderByWithRelationInput[] = sort.map(({ field, direction }) => {
    switch (field) {
      case 'lastName':
        return { profile: { lastName: direction } };
      case 'lastLoginAt':
        return { lastLoginAt: { sort: direction, nulls: 'last' } };
      case 'createdAt':
        return { createdAt: direction };
      case 'email':
        return { email: direction };
    }
  });
  if (order.length === 0) order.push({ createdAt: 'desc' });
  order.push({ id: 'asc' }); // stable pages
  return order;
}

export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: ObjectStorage,
  ) {}

  async list(query: AdminUserListQuery): Promise<{
    items: AdminUserListItem[];
    page: { page: number; pageSize: number; total: number };
  }> {
    const where: Prisma.UserWhereInput = {
      role: query.role,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.hasDebt === true ? { wallets: { some: { debtMinor: { gt: 0 } } } } : {}),
      ...(query.hasDebt === false ? { wallets: { none: { debtMinor: { gt: 0 } } } } : {}),
      AND: userSearchFilter(query.q),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: USER_ROW_SELECT,
        orderBy: orderBy(query.sort),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      items: await Promise.all(rows.map((row) => this.toListItem(row))),
      page: { page: query.page, pageSize: query.pageSize, total },
    };
  }

  async get(userId: string): Promise<AdminUserDetail> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_ROW_SELECT,
    });
    if (!row) throw AppError.notFound('User');
    return this.toDetail(row);
  }

  /**
   * Activates (incl. approving a pending registration) or deactivates an account.
   * Deactivation signs the user out everywhere immediately.
   */
  async updateStatus(
    actor: Actor,
    userId: string,
    input: UpdateUserStatusRequest,
    ctx: AuditContext,
  ): Promise<AdminUserDetail> {
    if (actor.id === userId) {
      throw new AppError('CANNOT_MODIFY_OWN_ACCOUNT', 'Admins cannot change their own status');
    }

    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: USER_ROW_SELECT });
      if (!user || user.deletedAt) throw AppError.notFound('User');
      if (user.status === input.status) return; // idempotent

      await tx.user.update({
        where: { id: userId },
        data: {
          status: input.status,
          ...(input.status === 'INACTIVE' ? { tokenVersion: { increment: 1 } } : {}),
        },
      });
      if (input.status === 'INACTIVE') {
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      if (user.status === 'PENDING_APPROVAL' && input.status === 'ACTIVE') {
        await enqueueOutbox(tx, 'email.send', {
          to: user.email,
          template: 'accountApproved',
          language: toLanguage(user.profile?.preferredLanguage),
          params: { firstName: user.profile?.firstName ?? '' },
        });
      }
      await writeAudit(tx, ctx, {
        action: 'user.status_changed',
        entityType: 'User',
        entityId: userId,
        before: { status: user.status },
        after: { status: input.status, reason: input.reason },
      });
    });

    return this.get(userId);
  }

  private async toListItem(row: UserRow): Promise<AdminUserListItem> {
    const wallet = row.wallets[0];
    const currency = wallet && isCurrencyCode(wallet.currency) ? wallet.currency : DEFAULT_CURRENCY;
    return {
      id: row.id,
      email: row.email,
      firstName: row.profile?.firstName ?? '',
      lastName: row.profile?.lastName ?? '',
      avatarUrl: await avatarUrl(this.storage, row.profile?.avatarKey),
      role: row.role,
      status: row.status,
      emailVerified: row.emailVerifiedAt !== null,
      // Admins have no wallet (D3).
      balance: wallet ? { amountMinor: wallet.balanceMinor, currency } : null,
      debt: wallet ? { amountMinor: wallet.debtMinor, currency } : null,
      createdAt: row.createdAt.toISOString(),
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    };
  }

  private async toDetail(row: UserRow): Promise<AdminUserDetail> {
    return {
      ...(await this.toListItem(row)),
      phone: row.profile?.phone ?? null,
      preferredLanguage: toLanguage(row.profile?.preferredLanguage),
      deletedAt: row.deletedAt?.toISOString() ?? null,
    };
  }
}
