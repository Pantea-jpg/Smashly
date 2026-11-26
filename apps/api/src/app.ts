import cors from 'cors';
import express, { type Express, Router } from 'express';
import helmet from 'helmet';
import type { Env } from './config/env';
import { authenticate, viewAsReadOnlyGuard } from './core/auth/authenticate';
import type { PasswordBreachCheck } from './core/auth/breached-passwords';
import type { TokenService } from './core/auth/tokens';
import { requestContext } from './core/context/request-context';
import type { PrismaClient } from './core/db/prisma';
import { errorHandler, notFoundHandler } from './core/errors/error-handler';
import { requestLogging } from './core/http/request-logging';
import type { Logger } from './core/logger/logger';
import type { RateLimiters } from './core/security/rate-limit';
import type { PaymentProvider } from './integrations/payments/payment-provider';
import type { ObjectStorage } from './integrations/storage/object-storage';
import { adminRouter } from './modules/admin/admin.routes';
import { SettingsService } from './modules/admin/settings.service';
import { ViewSessionsService } from './modules/admin/view-sessions.service';
import { authRouter } from './modules/auth/auth.routes';
import { AuthService } from './modules/auth/auth.service';
import { type DependencyCheck, healthRouter } from './modules/health/health.routes';
import { PaymentsService } from './modules/payments/payments.service';
import { documentStripeWebhook, stripeWebhookRouter } from './modules/payments/webhook.routes';
import { DevicesService } from './modules/notifications/devices.service';
import { NotificationsService } from './modules/notifications/notifications.service';
import { meRouter } from './modules/profiles/me.routes';
import { ReconciliationService } from './modules/reports/reconciliation.service';
import { ReportsService } from './modules/reports/reports.service';
import { ProfileService } from './modules/profiles/profile.service';
import { AttendanceService } from './modules/trainings/attendance.service';
import { PricingService } from './modules/trainings/pricing.service';
import { SeriesService } from './modules/trainings/series.service';
import { TrainingsService } from './modules/trainings/trainings.service';
import { AdminUsersService } from './modules/users/admin-users.service';
import { LedgerService } from './modules/wallets/ledger.service';
import { WalletQueryService } from './modules/wallets/wallet-query.service';
import {
  createOpenApiRegistry,
  docsRouter,
  generateOpenApiDocument,
  type OpenApiDocument,
} from './openapi/document';

export interface AppDependencies {
  env: Pick<
    Env,
    | 'APP_VERSION'
    | 'CORS_ORIGINS'
    | 'TRUST_PROXY_HOPS'
    | 'ENABLE_API_DOCS'
    | 'REFRESH_TOKEN_TTL_DAYS'
    | 'APP_LINK_BASE'
  >;
  logger: Logger;
  prisma: PrismaClient;
  tokens: TokenService;
  storage: ObjectStorage;
  /** null when Stripe is not configured (development): online top-ups answer 503. */
  paymentProvider: PaymentProvider | null;
  rateLimiters: RateLimiters;
  healthChecks: DependencyCheck[];
  /** Breached-password check for new passwords (Have I Been Pwned in deployed environments). */
  passwordBreachCheck?: PasswordBreachCheck;
  now?: () => Date;
}

export interface App extends Express {
  locals: Express['locals'] & {
    openApiDocument: () => OpenApiDocument;
    services: {
      ledger: LedgerService;
      payments: PaymentsService;
      reconciliation: ReconciliationService;
    };
  };
}

export const API_PREFIX = '/api/v1';
const JSON_BODY_LIMIT = '100kb';

/**
 * Builds the Express app without binding a port, so tests can drive it with supertest
 * and inject their own dependencies.
 */
export function createApp(deps: AppDependencies): App {
  const app = express() as App;
  const registry = createOpenApiRegistry();
  app.locals.openApiDocument = () => generateOpenApiDocument(registry, deps.env.APP_VERSION);

  // ── Services ─────────────────────────────────────────────────────────────
  const now = deps.now ?? (() => new Date());
  const settings = new SettingsService(deps.prisma);
  const auth = new AuthService(
    deps.prisma,
    deps.tokens,
    settings,
    {
      refreshTokenTtlDays: deps.env.REFRESH_TOKEN_TTL_DAYS,
      appLinkBase: deps.env.APP_LINK_BASE,
      breachCheck: deps.passwordBreachCheck,
    },
    now,
  );
  const profiles = new ProfileService(deps.prisma, deps.storage, deps.logger, now);
  const adminUsers = new AdminUsersService(deps.prisma, deps.storage);
  const viewSessions = new ViewSessionsService(deps.prisma, auth, now);
  const ledger = new LedgerService(deps.prisma, settings);
  const walletQueries = new WalletQueryService(deps.prisma, settings);
  const payments = new PaymentsService(
    deps.prisma,
    ledger,
    settings,
    deps.paymentProvider,
    deps.logger,
    now,
  );
  const reconciliation = new ReconciliationService(deps.prisma, now);
  const reports = new ReportsService(deps.prisma, reconciliation, now);
  const trainings = new TrainingsService(deps.prisma, ledger, settings, now);
  const attendance = new AttendanceService(deps.prisma, ledger, trainings, now);
  const pricing = new PricingService(deps.prisma, now);
  const series = new SeriesService(deps.prisma, now);
  const notifications = new NotificationsService(deps.prisma, now);
  const devices = new DevicesService(deps.prisma, now);
  app.locals.services = { ledger, payments, reconciliation };

  // ── HTTP pipeline ────────────────────────────────────────────────────────
  app.disable('x-powered-by');
  app.set('trust proxy', deps.env.TRUST_PROXY_HOPS);
  app.set('query parser', 'simple');

  app.use(requestLogging(deps.logger));

  // Swagger UI needs inline scripts, so it is mounted before the strict CSP. Never in production.
  if (deps.env.ENABLE_API_DOCS) {
    app.use(
      '/api/docs',
      docsRouter(() => app.locals.openApiDocument()),
    );
  }

  app.use(helmet());
  app.use(
    cors({
      origin: deps.env.CORS_ORIGINS.length > 0 ? deps.env.CORS_ORIGINS : false,
      credentials: false,
      maxAge: 600,
    }),
  );

  // Health probes sit outside the versioned API and before body parsing.
  app.use('/health', healthRouter({ version: deps.env.APP_VERSION, checks: deps.healthChecks }));

  // View-as mode is read-only, enforced before ANY route runs (webhooks included).
  app.use(viewAsReadOnlyGuard);

  // Stripe signs the raw bytes: the webhook must be mounted BEFORE express.json().
  app.use(`${API_PREFIX}/webhooks`, stripeWebhookRouter(payments));
  documentStripeWebhook(registry);

  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true }));
  app.use(requestContext);

  const authenticateMw = authenticate({ tokens: deps.tokens, prisma: deps.prisma, now });

  const api = Router();
  // Responses carry personal and financial data: never store them in a shared or device
  // cache (ASVS 8.2.1). Errors set by the handler below inherit this header.
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(deps.rateLimiters.global);
  api.use(
    '/auth',
    authRouter({
      registry,
      prefix: `${API_PREFIX}/auth`,
      auth,
      authenticate: authenticateMw,
      limits: deps.rateLimiters,
    }),
  );
  api.use(
    '/me',
    meRouter({
      registry,
      prefix: `${API_PREFIX}/me`,
      auth,
      profiles,
      walletQueries,
      payments,
      trainings,
      notifications,
      devices,
      authenticate: authenticateMw,
    }),
  );
  api.use(
    '/admin',
    adminRouter({
      registry,
      prefix: `${API_PREFIX}/admin`,
      prisma: deps.prisma,
      authenticate: authenticateMw,
      users: adminUsers,
      settings,
      viewSessions,
      ledger,
      walletQueries,
      payments,
      reports,
      reconciliation,
      trainings,
      attendance,
      pricing,
      series,
    }),
  );
  app.use(API_PREFIX, api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
