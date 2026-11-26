/**
 * Seeds the first administrator (idempotent) and, outside production, optional demo users.
 *
 *   pnpm --filter @tw/api db:seed
 *
 * Required: SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD (min 10 chars).
 * Optional: SEED_ADMIN_FIRST_NAME, SEED_ADMIN_LAST_NAME, SEED_ADMIN_RESET_PASSWORD=true,
 *           SEED_DEMO_USERS=true + SEED_DEMO_PASSWORD (never in production).
 * An existing admin's password is only changed when SEED_ADMIN_RESET_PASSWORD=true.
 */
import { EmailSchema, NewPasswordSchema } from '@tw/contracts';
import { DEFAULT_CURRENCY } from '@tw/money';
import { z } from 'zod';
import { writeAudit } from '../src/core/audit/audit';
import { hashPassword } from '../src/core/auth/password';
import { SYSTEM_CONTEXT } from '../src/core/context/request-context';
import { createPrismaClient, type PrismaClient } from '../src/core/db/prisma';

const flag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

const SeedEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  SEED_ADMIN_EMAIL: EmailSchema,
  SEED_ADMIN_PASSWORD: NewPasswordSchema,
  SEED_ADMIN_FIRST_NAME: z.string().trim().min(1).default('Admin'),
  SEED_ADMIN_LAST_NAME: z.string().trim().min(1).default('Account'),
  SEED_ADMIN_RESET_PASSWORD: flag,
  SEED_DEMO_USERS: flag,
  SEED_DEMO_PASSWORD: NewPasswordSchema.optional(),
});

const DEMO_USERS = [
  { email: 'anna.devries@example.test', firstName: 'Anna', lastName: 'de Vries', language: 'nl' },
  { email: 'sem.jansen@example.test', firstName: 'Sem', lastName: 'Jansen', language: 'nl' },
  { email: 'olivia.smith@example.test', firstName: 'Olivia', lastName: 'Smith', language: 'en' },
] as const;

async function seedAdmin(prisma: PrismaClient, env: z.infer<typeof SeedEnvSchema>): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { email: env.SEED_ADMIN_EMAIL } });

  if (existing) {
    if (existing.role !== 'ADMIN') {
      throw new Error(`${env.SEED_ADMIN_EMAIL} exists as a non-admin user; refusing to promote it`);
    }
    const data = {
      status: 'ACTIVE' as const,
      ...(env.SEED_ADMIN_RESET_PASSWORD
        ? {
            passwordHash: await hashPassword(env.SEED_ADMIN_PASSWORD),
            tokenVersion: { increment: 1 },
          }
        : {}),
    };
    await prisma.user.update({ where: { id: existing.id }, data });
    console.log(
      `Admin ${env.SEED_ADMIN_EMAIL} already exists${env.SEED_ADMIN_RESET_PASSWORD ? ' (password reset)' : ''}.`,
    );
    return;
  }

  const passwordHash = await hashPassword(env.SEED_ADMIN_PASSWORD);
  await prisma.$transaction(async (tx) => {
    // D3: admins manage; they have no wallet.
    const admin = await tx.user.create({
      data: {
        email: env.SEED_ADMIN_EMAIL,
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        profile: {
          create: {
            firstName: env.SEED_ADMIN_FIRST_NAME,
            lastName: env.SEED_ADMIN_LAST_NAME,
            preferredLanguage: 'en',
          },
        },
      },
    });
    await writeAudit(tx, SYSTEM_CONTEXT, {
      action: 'seed.admin_created',
      entityType: 'User',
      entityId: admin.id,
    });
  });
  console.log(`Created admin ${env.SEED_ADMIN_EMAIL}.`);
}

async function seedDemoUsers(prisma: PrismaClient, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  for (const demo of DEMO_USERS) {
    const exists = await prisma.user.findUnique({ where: { email: demo.email } });
    if (exists) continue;
    await prisma.user.create({
      data: {
        email: demo.email,
        passwordHash,
        role: 'USER',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        profile: {
          create: {
            firstName: demo.firstName,
            lastName: demo.lastName,
            preferredLanguage: demo.language,
          },
        },
        wallets: { create: { currency: DEFAULT_CURRENCY } },
      },
    });
    console.log(`Created demo user ${demo.email}.`);
  }
}

async function main(): Promise<void> {
  const parsed = SeedEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid seed configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.SEED_DEMO_USERS && env.NODE_ENV === 'production') {
    throw new Error('SEED_DEMO_USERS is not allowed in production');
  }
  if (env.SEED_DEMO_USERS && !env.SEED_DEMO_PASSWORD) {
    throw new Error('SEED_DEMO_PASSWORD is required when SEED_DEMO_USERS=true');
  }

  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    await seedAdmin(prisma, env);
    if (env.SEED_DEMO_USERS && env.SEED_DEMO_PASSWORD) {
      await seedDemoUsers(prisma, env.SEED_DEMO_PASSWORD);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
