import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://app:app@localhost:5432/app',
  JWT_PRIVATE_KEY: 'dGVzdA==',
};

const deployed = {
  ...base,
  NODE_ENV: 'production',
  REDIS_URL: 'redis://cache:6379',
  SMTP_URL: 'smtp://smtp.example:587',
  EMAIL_FROM: 'Training Wallet <no-reply@example.com>',
  S3_BUCKET: 'training-wallet-prod',
  STRIPE_SECRET_KEY: 'sk_live_x',
  STRIPE_PUBLISHABLE_KEY: 'pk_live_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
  APNS_KEY_ID: 'ABC123DEFG',
  APNS_TEAM_ID: 'TEAM123456',
  APNS_PRIVATE_KEY: 'cDg=',
  APNS_ENVIRONMENT: 'production',
  SENTRY_DSN: 'https://public@o1.ingest.de.sentry.io/1',
};

describe('loadEnv', () => {
  it('requires an https Sentry DSN in production, and not elsewhere', () => {
    const { SENTRY_DSN: _dsn, ...withoutSentry } = deployed;
    expect(() => loadEnv(withoutSentry)).toThrow(/SENTRY_DSN is required in production/);
    expect(() => loadEnv({ ...deployed, SENTRY_DSN: 'http://insecure' })).toThrow(/https/);
    expect(loadEnv({ ...withoutSentry, NODE_ENV: 'staging' }).SENTRY_DSN).toBeUndefined();
  });

  it('lets staging run without Stripe (top-ups off) but never production', () => {
    const {
      STRIPE_SECRET_KEY: _s,
      STRIPE_PUBLISHABLE_KEY: _p,
      STRIPE_WEBHOOK_SECRET: _w,
      ...noStripe
    } = deployed;
    expect(loadEnv({ ...noStripe, NODE_ENV: 'staging' }).STRIPE_SECRET_KEY).toBeUndefined();
    expect(() => loadEnv(noStripe)).toThrow(/Stripe keys are required in production/);
  });

  it('allows SMTP_URL=log:// (emails written to the log) everywhere except production', () => {
    expect(loadEnv({ ...deployed, NODE_ENV: 'staging', SMTP_URL: 'log://' }).SMTP_URL).toBe(
      'log://',
    );
    expect(() => loadEnv({ ...deployed, SMTP_URL: 'log://' })).toThrow(/real SMTP server/);
  });

  it('applies defaults', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      CORS_ORIGINS: [],
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_DAYS: 30,
    });
    expect(env.REDIS_URL).toBeUndefined();
  });

  it('uses the deployed git commit as the version on Render unless APP_VERSION is set', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    expect(loadEnv({ ...base, RENDER_GIT_COMMIT: commit }).APP_VERSION).toBe('0123456789ab');
    expect(loadEnv({ ...base, RENDER_GIT_COMMIT: commit, APP_VERSION: 'v1.2.0' }).APP_VERSION).toBe(
      'v1.2.0',
    );
    expect(loadEnv(base).APP_VERSION).toBe('0.0.0-dev');
  });

  it('parses comma lists and booleans', () => {
    const env = loadEnv({
      ...base,
      CORS_ORIGINS: 'https://a.example, https://b.example',
      ENABLE_API_DOCS: 'true',
    });
    expect(env.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
    expect(env.ENABLE_API_DOCS).toBe(true);
  });

  it('fails fast when DATABASE_URL or JWT_PRIVATE_KEY is missing', () => {
    expect(() => loadEnv({ JWT_PRIVATE_KEY: 'x' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...base, DATABASE_URL: 'mysql://x' })).toThrow(/postgres/);
    expect(() => loadEnv({ DATABASE_URL: base.DATABASE_URL })).toThrow(/JWT_PRIVATE_KEY/);
  });

  it('accepts a complete production configuration', () => {
    expect(() => loadEnv(deployed)).not.toThrow();
  });

  it('requires APNs credentials (production environment) in production', () => {
    const { APNS_KEY_ID: _omit, ...withoutKey } = deployed;
    expect(() => loadEnv(withoutKey)).toThrow(/APNs credentials|set together/);
    expect(() => loadEnv({ ...deployed, APNS_ENVIRONMENT: 'sandbox' })).toThrow(/APNS_ENVIRONMENT/);
    expect(() => loadEnv({ ...base, APNS_KEY_ID: 'x' })).toThrow(/set together/);
  });

  it('refuses API docs in production', () => {
    expect(() => loadEnv({ ...deployed, ENABLE_API_DOCS: 'true' })).toThrow(/ENABLE_API_DOCS/);
  });

  it.each(['REDIS_URL', 'SMTP_URL', 'EMAIL_FROM', 'S3_BUCKET'] as const)(
    'requires %s in production',
    (key) => {
      const { [key]: _omitted, ...rest } = deployed;
      expect(() => loadEnv(rest)).toThrow(new RegExp(key));
    },
  );

  it('treats an empty REDIS_URL as unset', () => {
    expect(loadEnv({ ...base, REDIS_URL: '  ' }).REDIS_URL).toBeUndefined();
  });

  it('requires previous JWT key and id together', () => {
    expect(() => loadEnv({ ...base, JWT_PREVIOUS_PUBLIC_KEY: 'abc' })).toThrow(/together/);
  });

  it('requires all Stripe keys together, live keys in production, and no stripe-mock', () => {
    expect(() => loadEnv({ ...base, STRIPE_SECRET_KEY: 'sk_test_x' })).toThrow(/set together/);
    expect(() => loadEnv({ ...deployed, STRIPE_SECRET_KEY: 'sk_test_x' })).toThrow(/test key/);
    expect(() => loadEnv({ ...deployed, STRIPE_API_URL: 'http://localhost:12111' })).toThrow(
      /stripe-mock/,
    );
    const { STRIPE_SECRET_KEY: _s, ...noStripe } = deployed;
    expect(() => loadEnv(noStripe)).toThrow(/Stripe/);
  });
});
