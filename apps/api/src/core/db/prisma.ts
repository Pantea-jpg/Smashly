import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../../generated/prisma/client';

/**
 * Prisma 7 uses driver adapters: the client talks to Postgres through node-postgres.
 * One client per process; pass it explicitly (no module-level singleton) so tests
 * can supply their own instance.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}

/** A client or an interactive-transaction client; repositories accept either. */
export type Db = PrismaClient | Prisma.TransactionClient;

export function isUniqueViolation(error: unknown, target?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  if (!target) return true;
  return JSON.stringify(error.meta ?? {}).includes(target);
}

export { Prisma, PrismaClient };
