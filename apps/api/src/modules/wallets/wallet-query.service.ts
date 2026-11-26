import type {
  AdminPayment,
  AdminTransaction,
  AdminTransactionQuery,
  AdminWallet,
  AdminWalletQuery,
  Debt,
  Payment,
  PaymentStatus,
  TopUpLimits,
  Transaction,
  TransactionType,
  Wallet,
} from '@tw/contracts';
import { DEFAULT_CURRENCY } from '@tw/money';
import type { Prisma, PrismaClient } from '../../core/db/prisma';
import { AppError } from '../../core/errors/app-error';
import type { SettingsService } from '../admin/settings.service';
import { userSearchFilter } from '../users/admin-users.service';
import {
  money,
  TRANSACTION_INCLUDE,
  toAdminTransaction,
  toDebt,
  toPayment,
  toTransaction,
} from './mappers';

/** Cursor over a wallet's gap-free ledger sequence (stable, unlike timestamps). */
export function encodeSequenceCursor(sequence: number): string {
  return Buffer.from(`seq:${sequence}`, 'utf8').toString('base64url');
}

export function decodeSequenceCursor(cursor: string): number {
  const match = /^seq:(\d{1,10})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!match?.[1]) throw AppError.validation({ cursor: 'invalid' }, 'Invalid cursor');
  return Number(match[1]);
}

type Page<T> = { items: T[]; page: { page: number; pageSize: number; total: number } };
type Feed<T> = { items: T[]; page: { nextCursor: string | null; hasMore: boolean } };

/** Read side of the wallet: never writes. All money movement goes through LedgerService. */
export class WalletQueryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
  ) {}

  async topUpLimits(): Promise<TopUpLimits> {
    const [minMinor, maxMinor, maxBalanceMinor, presetsMinor] = await Promise.all([
      this.settings.get('wallet.topUpMinMinor'),
      this.settings.get('wallet.topUpMaxMinor'),
      this.settings.get('wallet.maxBalanceMinor'),
      this.settings.get('wallet.topUpPresetsMinor'),
    ]);
    return { minMinor, maxMinor, maxBalanceMinor, presetsMinor: [...presetsMinor] };
  }

  async getWallet(userId: string): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findFirst({
      where: { userId, currency: DEFAULT_CURRENCY },
      include: { user: { select: { emailVerifiedAt: true, status: true } } },
    });
    if (!wallet) throw AppError.notFound('Wallet');
    return {
      id: wallet.id,
      balance: money(wallet.balanceMinor, wallet.currency),
      debt: money(wallet.debtMinor, wallet.currency),
      topUpLimits: await this.topUpLimits(),
      canTopUp: wallet.user.emailVerifiedAt !== null && wallet.user.status === 'ACTIVE',
    };
  }

  /** A user's ledger, newest first. */
  async listTransactions(
    userId: string,
    query: { limit: number; cursor?: string | undefined; type?: TransactionType | undefined },
  ): Promise<Feed<Transaction>> {
    const feed = await this.feed(userId, query);
    return { items: feed.rows.map(toTransaction), page: feed.page };
  }

  async listAdminUserTransactions(
    userId: string,
    query: { limit: number; cursor?: string | undefined; type?: TransactionType | undefined },
  ): Promise<Feed<AdminTransaction>> {
    const feed = await this.feed(userId, query);
    return { items: feed.rows.map(toAdminTransaction), page: feed.page };
  }

  private async feed(
    userId: string,
    query: { limit: number; cursor?: string | undefined; type?: TransactionType | undefined },
  ) {
    const before = query.cursor ? decodeSequenceCursor(query.cursor) : undefined;
    const rows = await this.prisma.walletTransaction.findMany({
      where: {
        userId,
        ...(query.type ? { type: query.type } : {}),
        ...(before !== undefined ? { sequence: { lt: before } } : {}),
      },
      include: TRANSACTION_INCLUDE,
      orderBy: { sequence: 'desc' },
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      rows: page,
      page: { nextCursor: hasMore && last ? encodeSequenceCursor(last.sequence) : null, hasMore },
    };
  }

  async getTransaction(userId: string, transactionId: string): Promise<Transaction> {
    const row = await this.prisma.walletTransaction.findFirst({
      where: { id: transactionId, userId },
      include: TRANSACTION_INCLUDE,
    });
    if (!row) throw AppError.notFound('Transaction');
    return toTransaction(row);
  }

  async listDebts(userId: string): Promise<Debt[]> {
    const rows = await this.prisma.debt.findMany({
      where: { userId },
      include: { trainingCharge: { select: { trainingId: true } } },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    });
    return rows.map(toDebt);
  }

  async listUserPayments(userId: string): Promise<Payment[]> {
    const rows = await this.prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map(toPayment);
  }

  async getPayment(userId: string, paymentId: string): Promise<Payment> {
    const row = await this.prisma.payment.findFirst({ where: { id: paymentId, userId } });
    if (!row) throw AppError.notFound('Payment');
    return toPayment(row);
  }

  // ── Admin ───────────────────────────────────────────────────────────────

  async listAdminTransactions(query: AdminTransactionQuery): Promise<Page<AdminTransaction>> {
    const where: Prisma.WalletTransactionWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.adminId ? { createdByAdminId: query.adminId } : {}),
      ...(query.method ? { paymentMethod: query.method } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lt: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.walletTransaction.count({ where }),
      this.prisma.walletTransaction.findMany({
        where,
        include: TRANSACTION_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { sequence: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: rows.map(toAdminTransaction),
      page: { page: query.page, pageSize: query.pageSize, total },
    };
  }

  async getAdminTransaction(transactionId: string): Promise<{
    transaction: AdminTransaction;
    related: AdminTransaction[];
  }> {
    const row = await this.prisma.walletTransaction.findUnique({
      where: { id: transactionId },
      include: TRANSACTION_INCLUDE,
    });
    if (!row) throw AppError.notFound('Transaction');
    const related = await this.prisma.walletTransaction.findMany({
      where: {
        id: { not: row.id },
        OR: [
          { groupId: row.groupId },
          { reversesTransactionId: row.id },
          ...(row.reversesTransactionId ? [{ id: row.reversesTransactionId }] : []),
        ],
      },
      include: TRANSACTION_INCLUDE,
      orderBy: { sequence: 'asc' },
    });
    return { transaction: toAdminTransaction(row), related: related.map(toAdminTransaction) };
  }

  async listWallets(query: AdminWalletQuery): Promise<Page<AdminWallet>> {
    const where: Prisma.WalletWhereInput = {
      user: { deletedAt: null, AND: userSearchFilter(query.q) },
      ...(query.hasDebt === true ? { debtMinor: { gt: 0 } } : {}),
      ...(query.hasDebt === false ? { debtMinor: 0 } : {}),
    };
    const orderBy: Prisma.WalletOrderByWithRelationInput[] = query.sort.map(
      ({ field, direction }) =>
        field === 'balance'
          ? { balanceMinor: direction }
          : field === 'debt'
            ? { debtMinor: direction }
            : { updatedAt: direction },
    );
    if (orderBy.length === 0) orderBy.push({ updatedAt: 'desc' });
    orderBy.push({ id: 'asc' });

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.wallet.count({ where }),
      this.prisma.wallet.findMany({
        where,
        include: {
          user: {
            select: { email: true, profile: { select: { firstName: true, lastName: true } } },
          },
        },
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: rows.map((w) => ({
        id: w.id,
        userId: w.userId,
        email: w.user.email,
        firstName: w.user.profile?.firstName ?? '',
        lastName: w.user.profile?.lastName ?? '',
        balance: money(w.balanceMinor, w.currency),
        debt: money(w.debtMinor, w.currency),
        updatedAt: w.updatedAt.toISOString(),
      })),
      page: { page: query.page, pageSize: query.pageSize, total },
    };
  }

  async listAdminPayments(query: {
    page: number;
    pageSize: number;
    status?: PaymentStatus | undefined;
    userId?: string | undefined;
  }): Promise<Page<AdminPayment>> {
    const where: Prisma.PaymentWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: rows.map((p) => ({
        ...toPayment(p),
        userId: p.userId,
        providerPaymentId: p.providerPaymentId,
      })),
      page: { page: query.page, pageSize: query.pageSize, total },
    };
  }
}
