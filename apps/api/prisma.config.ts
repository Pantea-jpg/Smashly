import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads the connection URL from schema.prisma or loads .env itself.
// `prisma generate` does not need a database, so a missing URL is only an error for
// commands that connect (migrate, studio); those fail with a clear Prisma message.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
    // Scratch database Prisma uses to replay migrations for drift checks (migrate dev/diff).
    ...(process.env['SHADOW_DATABASE_URL']
      ? { shadowDatabaseUrl: process.env['SHADOW_DATABASE_URL'] }
      : {}),
  },
});
