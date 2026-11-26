import { generateKeyPairSync } from 'node:crypto';
import { pino } from 'pino';
import { type App, createApp } from '../src/app';
import { hashPassword } from '../src/core/auth/password';
import type { PasswordBreachCheck } from '../src/core/auth/breached-passwords';
import { type TokenConfig, TokenService } from '../src/core/auth/tokens';
import { createPrismaClient, type PrismaClient } from '../src/core/db/prisma';
import {
  createRateLimiters,
  type RateLimitConfig,
  DEFAULT_RATE_LIMITS,
} from '../src/core/security/rate-limit';
import { FakePaymentProvider } from '../src/integrations/payments/fake-payment-provider';
import { MemoryObjectStorage } from '../src/integrations/storage/object-storage';
import type { DependencyCheck } from '../src/modules/health/health.routes';

export function generateTestKey(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).toString(
    'base64',
  );
}

export const TEST_TOKEN_CONFIG: TokenConfig = {
  JWT_PRIVATE_KEY: generateTestKey(),
  JWT_KEY_ID: 'test-k1',
  JWT_PREVIOUS_PUBLIC_KEY: undefined,
  JWT_PREVIOUS_KEY_ID: undefined,
  JWT_ISSUER: 'training-wallet-api',
  JWT_AUDIENCE: 'training-wallet-app',
  ACCESS_TOKEN_TTL_SECONDS: 900,
};

/** Generous limits so suites are not throttled; rate-limit tests pass their own. */
export const RELAXED_RATE_LIMITS: RateLimitConfig = Object.fromEntries(
  Object.entries(DEFAULT_RATE_LIMITS).map(([name, rule]) => [name, { ...rule, limit: 10_000 }]),
) as RateLimitConfig;

export interface TestAppOptions {
  prisma?: PrismaClient;
  rateLimits?: Partial<RateLimitConfig>;
  healthChecks?: DependencyCheck[];
  corsOrigins?: string[];
  storage?: MemoryObjectStorage;
  /** Defaults to a fresh FakePaymentProvider; pass null to simulate "Stripe not configured". */
  paymentProvider?: FakePaymentProvider | null;
  now?: () => Date;
  passwordBreachCheck?: PasswordBreachCheck;
}

/** A client that is never connected; for unit tests that do not touch the database. */
export function offlinePrisma(): PrismaClient {
  return createPrismaClient('postgresql://offline:offline@127.0.0.1:1/offline');
}

export function buildTestApp(options: TestAppOptions = {}): {
  app: App;
  tokens: TokenService;
  storage: MemoryObjectStorage;
  payments: FakePaymentProvider | null;
} {
  const tokens = new TokenService(TEST_TOKEN_CONFIG, options.now);
  const storage = options.storage ?? new MemoryObjectStorage();
  const payments =
    options.paymentProvider === undefined ? new FakePaymentProvider() : options.paymentProvider;
  const app = createApp({
    env: {
      APP_VERSION: 'test',
      CORS_ORIGINS: options.corsOrigins ?? [],
      TRUST_PROXY_HOPS: 0,
      ENABLE_API_DOCS: true,
      REFRESH_TOKEN_TTL_DAYS: 30,
      APP_LINK_BASE: 'trainingwallet://',
    },
    logger: pino({ level: 'silent' }),
    prisma: options.prisma ?? offlinePrisma(),
    tokens,
    storage,
    paymentProvider: payments,
    rateLimiters: createRateLimiters({
      config: { ...RELAXED_RATE_LIMITS, ...options.rateLimits },
    }),
    healthChecks: options.healthChecks ?? [],
    ...(options.passwordBreachCheck ? { passwordBreachCheck: options.passwordBreachCheck } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { app, tokens, storage, payments };
}

let counter = 0;
export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}.${Date.now().toString(36)}.${counter}@example.test`;
}

export const TEST_PASSWORD = 'correct horse battery staple';

/** Inserts a user directly (bypassing the API), e.g. admins or inactive accounts. */
export async function createUser(
  prisma: PrismaClient,
  options: {
    email?: string;
    role?: 'ADMIN' | 'USER';
    status?: 'ACTIVE' | 'INACTIVE' | 'PENDING_APPROVAL';
    password?: string;
  } = {},
): Promise<{ id: string; email: string; password: string }> {
  const email = options.email ?? uniqueEmail(options.role === 'ADMIN' ? 'admin' : 'user');
  const password = options.password ?? TEST_PASSWORD;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      role: options.role ?? 'USER',
      status: options.status ?? 'ACTIVE',
      profile: { create: { firstName: 'Test', lastName: 'User', preferredLanguage: 'en' } },
      ...(options.role === 'ADMIN' ? {} : { wallets: { create: { currency: 'EUR' } } }),
    },
  });
  return { id: user.id, email, password };
}
