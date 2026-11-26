import { afterAll, beforeEach, inject } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../src/core/db/prisma';

/**
 * One Prisma client per integration test file, with every table emptied before each test.
 * TRUNCATE does not fire row-level DELETE triggers, so append-only tables can be reset here
 * (only the test database owner can do this; the runtime role in production cannot).
 */
export function useTestDatabase(): PrismaClient {
  const prisma = createPrismaClient(inject('databaseUrl'));

  beforeEach(async () => {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  return prisma;
}
