/**
 * Writes apps/api/openapi.json from the route definitions (no database needed).
 * CI regenerates it and fails if the committed file differs, so API changes are reviewed.
 */
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pino } from 'pino';
import { createApp } from '../src/app';
import { TokenService } from '../src/core/auth/tokens';
import { createPrismaClient } from '../src/core/db/prisma';
import { createRateLimiters } from '../src/core/security/rate-limit';
import { MemoryObjectStorage } from '../src/integrations/storage/object-storage';

const { privateKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const app = createApp({
  env: {
    APP_VERSION: process.env['APP_VERSION'] ?? '1.0.0',
    CORS_ORIGINS: [],
    TRUST_PROXY_HOPS: 0,
    ENABLE_API_DOCS: false,
    REFRESH_TOKEN_TTL_DAYS: 30,
    APP_LINK_BASE: 'trainingwallet://',
  },
  logger: pino({ level: 'silent' }),
  // The client is never queried here; constructing it does not open a connection.
  prisma: createPrismaClient('postgresql://unused:unused@localhost:5432/unused'),
  tokens: new TokenService({
    JWT_PRIVATE_KEY: Buffer.from(pem).toString('base64'),
    JWT_KEY_ID: 'docs',
    JWT_PREVIOUS_PUBLIC_KEY: undefined,
    JWT_PREVIOUS_KEY_ID: undefined,
    JWT_ISSUER: 'training-wallet-api',
    JWT_AUDIENCE: 'training-wallet-app',
    ACCESS_TOKEN_TTL_SECONDS: 900,
  }),
  storage: new MemoryObjectStorage(),
  paymentProvider: null,
  rateLimiters: createRateLimiters({}),
  healthChecks: [],
});

const target = new URL('../openapi.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(app.locals.openApiDocument(), null, 2)}\n`);
console.log(`Wrote ${target.pathname}`);
