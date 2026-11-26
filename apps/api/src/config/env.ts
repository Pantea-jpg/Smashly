import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const commaList = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim().length > 0 ? value.trim() : undefined));

/**
 * Environment contract for the API and worker processes.
 * The process refuses to start when anything is missing or malformed.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_VERSION: z.string().min(1).default('0.0.0-dev'),

  DATABASE_URL: z
    .string()
    .min(1)
    .refine((url) => /^postgres(ql)?:\/\//.test(url), 'DATABASE_URL must be a postgres:// URL'),
  /** Shared store for rate limits (and Socket.IO later). Required outside development/test. */
  REDIS_URL: optionalString.refine((url) => url === undefined || /^rediss?:\/\//.test(url), {
    message: 'REDIS_URL must be a redis:// or rediss:// URL',
  }),

  /** Allowed browser origins (future web admin). The iOS app does not need CORS. */
  CORS_ORIGINS: commaList.default([]),
  /** Number of reverse-proxy hops to trust for client IPs (rate limiting, audit). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /** Serve Swagger UI at /api/docs. Never enabled in production. */
  ENABLE_API_DOCS: booleanString.default(false),

  // ── Authentication ────────────────────────────────────────────────────────
  /** Base64 of an Ed25519 PKCS#8 PEM private key. Generate: pnpm --filter @tw/api keys:generate */
  JWT_PRIVATE_KEY: z.string().min(1, 'JWT_PRIVATE_KEY is required'),
  JWT_KEY_ID: z.string().min(1).max(64).default('k1'),
  /** During key rotation: the previous key (base64 SPKI PEM) stays valid for verification. */
  JWT_PREVIOUS_PUBLIC_KEY: optionalString,
  JWT_PREVIOUS_KEY_ID: optionalString,
  JWT_ISSUER: z.string().min(1).default('training-wallet-api'),
  JWT_AUDIENCE: z.string().min(1).default('training-wallet-app'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** Check new passwords against Have I Been Pwned (k-anonymity; fails open when unreachable). */
  PASSWORD_BREACH_CHECK: booleanString.default(true),

  // ── Email ─────────────────────────────────────────────────────────────────
  /** smtp(s)://… to send; `log://` writes emails to the log instead (test environments only). */
  SMTP_URL: z.string().min(1).default('smtp://localhost:1025'),
  EMAIL_FROM: z.string().min(3).default('Training Wallet <no-reply@localhost>'),
  /** Prefix for links in emails that open the app (custom scheme now, universal links later). */
  APP_LINK_BASE: z.string().min(3).default('trainingwallet://'),

  // ── Object storage (profile pictures) ─────────────────────────────────────
  /** Custom endpoint for S3-compatible services (MinIO locally). Omit for AWS S3. */
  S3_ENDPOINT: optionalString,
  S3_REGION: z.string().min(1).default('eu-central-1'),
  S3_BUCKET: z.string().min(3).default('training-wallet-dev'),
  /** Omit both to use the default credential chain (e.g. an IAM role) in production. */
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_FORCE_PATH_STYLE: booleanString.default(false),

  // ── Stripe (online top-ups) ───────────────────────────────────────────────
  /** Without these, online top-ups answer PAYMENTS_UNAVAILABLE (dev/test only). */
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_PUBLISHABLE_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  /** Only for local testing against stripe-mock, e.g. http://localhost:12111. */
  STRIPE_API_URL: optionalString,

  // ── Push notifications (APNs) ─────────────────────────────────────────────
  /** Without these, pushes are only logged (dev/test). All four are set together. */
  APNS_KEY_ID: optionalString,
  APNS_TEAM_ID: optionalString,
  /** Base64 of the .p8 key file (PEM). */
  APNS_PRIVATE_KEY: optionalString,
  APNS_BUNDLE_ID: z.string().min(3).default('com.trainingwallet.app'),
  /** sandbox for development builds; production for TestFlight and App Store builds. */
  APNS_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),

  // ── Monitoring ────────────────────────────────────────────────────────────
  /** Sentry project DSN (EU region, de.sentry.io). Without it, alerts are only logged. */
  SENTRY_DSN: optionalString.refine((url) => url === undefined || url.startsWith('https://'), {
    message: 'SENTRY_DSN must be an https:// URL',
  }),
});

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // On Render the deployed git commit is RENDER_GIT_COMMIT; use it as the version unless one
  // is set explicitly (it tags /health, logs and Sentry releases).
  const result = EnvSchema.safeParse({
    ...source,
    APP_VERSION: source['APP_VERSION'] ?? source['RENDER_GIT_COMMIT']?.slice(0, 12),
  });
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new EnvValidationError(`Invalid environment configuration:\n${issues}`);
  }
  const env = result.data;
  const deployed = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
  const problems: string[] = [];

  if (env.NODE_ENV === 'production' && env.ENABLE_API_DOCS) {
    problems.push('ENABLE_API_DOCS must not be enabled in production');
  }
  if (deployed && !env.REDIS_URL) {
    problems.push('REDIS_URL is required in staging/production (shared rate-limit store)');
  }
  if (deployed && source['SMTP_URL'] === undefined) {
    problems.push('SMTP_URL must be set explicitly in staging/production');
  }
  if (deployed && source['EMAIL_FROM'] === undefined) {
    problems.push('EMAIL_FROM must be set explicitly in staging/production');
  }
  if (deployed && source['S3_BUCKET'] === undefined) {
    problems.push('S3_BUCKET must be set explicitly in staging/production');
  }
  const stripe = [env.STRIPE_SECRET_KEY, env.STRIPE_PUBLISHABLE_KEY, env.STRIPE_WEBHOOK_SECRET];
  if (stripe.some(Boolean) && !stripe.every(Boolean)) {
    problems.push(
      'STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY and STRIPE_WEBHOOK_SECRET must be set together',
    );
  }
  // Staging may run without Stripe (online top-ups then answer PAYMENTS_UNAVAILABLE), so the
  // rest of the app can be tested before a Stripe account exists. Production never.
  if (env.NODE_ENV === 'production' && !stripe.every(Boolean)) {
    problems.push('Stripe keys are required in production');
  }
  if (env.NODE_ENV === 'production' && env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
    problems.push('STRIPE_SECRET_KEY is a test key in production');
  }
  if (deployed && env.STRIPE_API_URL) {
    problems.push('STRIPE_API_URL (stripe-mock) must not be set in staging/production');
  }
  const apns = [env.APNS_KEY_ID, env.APNS_TEAM_ID, env.APNS_PRIVATE_KEY];
  if (apns.some(Boolean) && !apns.every(Boolean)) {
    problems.push('APNS_KEY_ID, APNS_TEAM_ID and APNS_PRIVATE_KEY must be set together');
  }
  if (env.NODE_ENV === 'production' && !apns.every(Boolean)) {
    problems.push('APNs credentials are required in production');
  }
  if (env.NODE_ENV === 'production' && env.APNS_ENVIRONMENT !== 'production') {
    problems.push('APNS_ENVIRONMENT must be production in production');
  }
  if (env.NODE_ENV === 'production' && env.SMTP_URL.startsWith('log:')) {
    problems.push(
      'SMTP_URL=log:// only writes emails to the logs; set a real SMTP server in production',
    );
  }
  if (env.NODE_ENV === 'production' && !env.SENTRY_DSN) {
    problems.push('SENTRY_DSN is required in production (alerts would only reach the logs)');
  }
  if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY)) {
    problems.push('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together');
  }
  if (Boolean(env.JWT_PREVIOUS_PUBLIC_KEY) !== Boolean(env.JWT_PREVIOUS_KEY_ID)) {
    problems.push('JWT_PREVIOUS_PUBLIC_KEY and JWT_PREVIOUS_KEY_ID must be set together');
  }

  if (problems.length > 0) {
    throw new EnvValidationError(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
  return env;
}
