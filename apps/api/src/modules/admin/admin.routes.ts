import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  AdminSettingsSchema,
  AdminUserDetailSchema,
  AdminUserListItemSchema,
  AdminUserListQuerySchema,
  AuditLogEntrySchema,
  AuditLogQuerySchema,
  CreateViewSessionRequestSchema,
  IdSchema,
  UpdateAdminSettingsRequestSchema,
  UpdateUserStatusRequestSchema,
  UserIdParamsSchema,
  ViewSessionSchema,
} from '@tw/contracts';
import type { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { writeAudit } from '../../core/audit/audit';
import { requireRole } from '../../core/auth/authenticate';
import { auditContextOf, requireActor } from '../../core/context/request-context';
import type { PrismaClient } from '../../core/db/prisma';
import { AppError } from '../../core/errors/app-error';
import { ApiRouter } from '../../core/http/api-router';
import { decodeIdCursor, encodeIdCursor } from '../../core/http/pagination';
import type { PaymentsService } from '../payments/payments.service';
import type { ReconciliationService } from '../reports/reconciliation.service';
import { registerReportRoutes } from '../reports/reports.routes';
import type { ReportsService } from '../reports/reports.service';
import type { AttendanceService } from '../trainings/attendance.service';
import type { PricingService } from '../trainings/pricing.service';
import type { SeriesService } from '../trainings/series.service';
import { registerAdminTrainingRoutes } from '../trainings/trainings.routes';
import type { TrainingsService } from '../trainings/trainings.service';
import type { AdminUsersService } from '../users/admin-users.service';
import type { LedgerService } from '../wallets/ledger.service';
import type { WalletQueryService } from '../wallets/wallet-query.service';
import { registerAdminMoneyRoutes } from '../wallets/wallet.routes';
import type { SettingsService } from './settings.service';
import type { ViewSessionsService } from './view-sessions.service';

export interface AdminRouterDeps {
  registry: OpenAPIRegistry;
  prefix: string;
  prisma: PrismaClient;
  authenticate: RequestHandler;
  users: AdminUsersService;
  settings: SettingsService;
  viewSessions: ViewSessionsService;
  ledger: LedgerService;
  walletQueries: WalletQueryService;
  payments: PaymentsService;
  reports: ReportsService;
  reconciliation: ReconciliationService;
  trainings: TrainingsService;
  attendance: AttendanceService;
  pricing: PricingService;
  series: SeriesService;
}

/** Admin endpoints act as the admin; a View-as context makes no sense here. */
const rejectViewMode: RequestHandler = (req, _res, next) => {
  if (req.context.readOnly) {
    throw new AppError('VIEW_AS_READ_ONLY', 'Admin endpoints are not available in view mode');
  }
  next();
};

/**
 * Every route on this router requires an authenticated ADMIN (enforced once, at router level).
 */
export function adminRouter(deps: AdminRouterDeps): Router {
  const api = new ApiRouter(deps.registry, deps.prefix);
  api.router.use(deps.authenticate, requireRole('ADMIN'), rejectViewMode);
  const tags = {
    users: ['Admin · Users'] as [string],
    viewAs: ['Admin · View as User'] as [string],
    system: ['Admin · System'] as [string],
  };

  // ── Users ────────────────────────────────────────────────────────────────

  api.offsetList(
    {
      method: 'get',
      path: '/users',
      summary: 'List users with search, filters, sorting and pages',
      description:
        '`q` matches every word against email, first and last name. Defaults to role=USER, newest first.',
      tags: tags.users,
      auth: 'admin',
      request: { query: AdminUserListQuerySchema },
      item: AdminUserListItemSchema,
    },
    ({ query }) => deps.users.list(query),
  );

  api.route(
    {
      method: 'get',
      path: '/users/:id',
      summary: 'User detail with wallet summary',
      tags: tags.users,
      auth: 'admin',
      request: { params: UserIdParamsSchema },
      response: { status: 200, schema: AdminUserDetailSchema },
      errors: ['NOT_FOUND'],
    },
    ({ params }) => deps.users.get(params.id),
  );

  api.route(
    {
      method: 'patch',
      path: '/users/:id/status',
      summary: 'Activate, approve or deactivate an account',
      description:
        'Deactivation signs the user out on all devices immediately. Activating a PENDING_APPROVAL account approves it and emails the user.',
      tags: tags.users,
      auth: 'admin',
      request: { params: UserIdParamsSchema, body: UpdateUserStatusRequestSchema },
      response: { status: 200, schema: AdminUserDetailSchema },
      errors: ['NOT_FOUND', 'CANNOT_MODIFY_OWN_ACCOUNT'],
    },
    ({ req, params, body }) =>
      deps.users.updateStatus(requireActor(req), params.id, body, auditContextOf(req)),
  );

  // ── View as User ─────────────────────────────────────────────────────────

  api.route(
    {
      method: 'post',
      path: '/view-sessions',
      summary: 'Start viewing the app as a user (read-only, 30 minutes)',
      description:
        'Send the returned id as `X-View-Session` on GET requests to `/me/*`. Any non-GET request carrying the header is rejected with VIEW_AS_READ_ONLY. Starting a new session ends your previous one.',
      tags: tags.viewAs,
      auth: 'admin',
      request: { body: CreateViewSessionRequestSchema },
      response: { status: 201, schema: ViewSessionSchema },
      errors: ['NOT_FOUND'],
    },
    ({ req, body }) => deps.viewSessions.start(requireActor(req), body.userId, auditContextOf(req)),
  );

  api.route(
    {
      method: 'delete',
      path: '/view-sessions/:id',
      summary: 'End a view session',
      description:
        'Call WITHOUT the X-View-Session header (non-GET requests with it are rejected).',
      tags: tags.viewAs,
      auth: 'admin',
      request: { params: z.object({ id: IdSchema }) },
      response: { status: 204, schema: null },
      errors: ['NOT_FOUND'],
    },
    async ({ req, params }) => {
      await deps.viewSessions.end(requireActor(req), params.id, auditContextOf(req));
    },
  );

  // ── Settings ─────────────────────────────────────────────────────────────

  /** API field ↔ stored setting key. */
  const SETTING_FIELDS = {
    registrationRequiresApproval: 'registration.requireApproval',
    topUpMinMinor: 'wallet.topUpMinMinor',
    topUpMaxMinor: 'wallet.topUpMaxMinor',
    maxBalanceMinor: 'wallet.maxBalanceMinor',
    topUpPresetsMinor: 'wallet.topUpPresetsMinor',
    lowBalanceThresholdMinor: 'wallet.lowBalanceThresholdMinor',
    reservationDebtBlockMinor: 'reservations.blockWhenDebtAboveMinor',
    quietHours: 'notifications.quietHours',
  } as const;

  const readSettings = async () => ({
    registrationRequiresApproval: await deps.settings.get('registration.requireApproval'),
    topUpMinMinor: await deps.settings.get('wallet.topUpMinMinor'),
    topUpMaxMinor: await deps.settings.get('wallet.topUpMaxMinor'),
    maxBalanceMinor: await deps.settings.get('wallet.maxBalanceMinor'),
    topUpPresetsMinor: [...(await deps.settings.get('wallet.topUpPresetsMinor'))],
    lowBalanceThresholdMinor: await deps.settings.get('wallet.lowBalanceThresholdMinor'),
    reservationDebtBlockMinor: await deps.settings.get('reservations.blockWhenDebtAboveMinor'),
    quietHours: await deps.settings.get('notifications.quietHours'),
  });

  api.route(
    {
      method: 'get',
      path: '/settings',
      summary: 'Business settings',
      tags: tags.system,
      auth: 'admin',
      response: { status: 200, schema: AdminSettingsSchema },
    },
    readSettings,
  );

  api.route(
    {
      method: 'patch',
      path: '/settings',
      summary: 'Update business settings',
      tags: tags.system,
      auth: 'admin',
      request: { body: UpdateAdminSettingsRequestSchema },
      response: { status: 200, schema: AdminSettingsSchema },
    },
    async ({ req, body }) => {
      const before = await readSettings();
      const min = body.topUpMinMinor ?? before.topUpMinMinor;
      const max = body.topUpMaxMinor ?? before.topUpMaxMinor;
      if (min > max) {
        throw AppError.validation(
          { topUpMinMinor: 'min_exceeds_max' },
          'Minimum top-up exceeds maximum',
        );
      }
      await deps.prisma.$transaction(async (tx) => {
        for (const [field, key] of Object.entries(SETTING_FIELDS) as [
          keyof typeof SETTING_FIELDS,
          (typeof SETTING_FIELDS)[keyof typeof SETTING_FIELDS],
        ][]) {
          const value = body[field];
          if (value !== undefined) {
            await deps.settings.set(key, value, requireActor(req).id, tx);
          }
        }
        await writeAudit(tx, auditContextOf(req), {
          action: 'settings.updated',
          entityType: 'AppSetting',
          before,
          after: body,
        });
      });
      return readSettings();
    },
  );

  // ── Money ────────────────────────────────────────────────────────────────

  registerAdminMoneyRoutes(api, {
    prisma: deps.prisma,
    ledger: deps.ledger,
    queries: deps.walletQueries,
    payments: deps.payments,
  });

  // ── Reports ──────────────────────────────────────────────────────────────

  registerAdminTrainingRoutes(api, {
    prisma: deps.prisma,
    trainings: deps.trainings,
    attendance: deps.attendance,
    pricing: deps.pricing,
    series: deps.series,
  });

  registerReportRoutes(api, {
    prisma: deps.prisma,
    reports: deps.reports,
    reconciliation: deps.reconciliation,
  });

  // ── Audit log ────────────────────────────────────────────────────────────

  api.cursorList(
    {
      method: 'get',
      path: '/audit-logs',
      summary: 'Browse the audit log (newest first)',
      tags: tags.system,
      auth: 'admin',
      request: { query: AuditLogQuerySchema },
      item: AuditLogEntrySchema,
    },
    async ({ query }) => {
      const cursorId = query.cursor ? decodeIdCursor(query.cursor) : undefined;
      // UUIDv7 ids are time-ordered, so ordering by id is ordering by creation time.
      const rows = await deps.prisma.auditLog.findMany({
        where: {
          ...(query.actorId ? { actorId: query.actorId } : {}),
          ...(query.entityType ? { entityType: query.entityType } : {}),
          ...(query.entityId ? { entityId: query.entityId } : {}),
          ...(query.action ? { action: query.action } : {}),
          ...(query.from || query.to
            ? {
                createdAt: {
                  ...(query.from ? { gte: new Date(query.from) } : {}),
                  ...(query.to ? { lt: new Date(query.to) } : {}),
                },
              }
            : {}),
          ...(cursorId ? { id: { lt: cursorId } } : {}),
        },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      const hasMore = rows.length > query.limit;
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items: items.map((row) => ({
          id: row.id,
          actorId: row.actorId,
          actorRole: row.actorRole,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          viewSessionId: row.viewSessionId,
          requestId: row.requestId,
          before: row.before,
          after: row.after,
          createdAt: row.createdAt.toISOString(),
        })),
        page: { nextCursor: hasMore && last ? encodeIdCursor(last.id) : null, hasMore },
      };
    },
  );

  return api.router;
}
