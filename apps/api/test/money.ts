import type { AuditContext } from '../src/core/context/request-context';
import type { PrismaClient } from '../src/core/db/prisma';
import { SettingsService } from '../src/modules/admin/settings.service';
import { LedgerService } from '../src/modules/wallets/ledger.service';

export function ledgerFor(prisma: PrismaClient): LedgerService {
  return new LedgerService(prisma, new SettingsService(prisma));
}

export function adminContext(adminId: string): AuditContext {
  return {
    actor: { id: adminId, role: 'ADMIN' },
    requestId: 'test',
    ip: null,
    userAgent: null,
    viewSessionId: null,
  };
}

let trainingCounter = 0;

/** A training plus a PRESENT attendance row, ready to be charged. */
export async function presentAt(
  prisma: PrismaClient,
  input: { adminId: string; userId: string; priceMinor?: number },
): Promise<{ trainingId: string; attendanceId: string; title: string }> {
  trainingCounter += 1;
  const startsAt = new Date(Date.now() - 2 * 3_600_000);
  const training = await prisma.training.create({
    data: {
      title: `Training ${trainingCounter}`,
      location: 'Hall A',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      reservationDeadline: new Date(startsAt.getTime() - 3_600_000),
      defaultPriceMinor: input.priceMinor ?? 1000,
      createdById: input.adminId,
    },
  });
  const attendance = await prisma.attendance.create({
    data: { trainingId: training.id, userId: input.userId, status: 'PRESENT' },
  });
  return { trainingId: training.id, attendanceId: attendance.id, title: training.title };
}

export async function chargeFor(
  prisma: PrismaClient,
  ledger: LedgerService,
  input: { adminId: string; userId: string; priceMinor: number },
) {
  const { trainingId, attendanceId, title } = await presentAt(prisma, input);
  return ledger.run(undefined, (tx) =>
    ledger.chargeTraining(
      tx,
      {
        trainingId,
        trainingTitle: title,
        userId: input.userId,
        attendanceId,
        unitPriceMinor: input.priceMinor,
        priceSource: 'TRAINING_DEFAULT',
        currency: 'EUR',
      },
      adminContext(input.adminId),
    ),
  );
}

export async function walletOf(prisma: PrismaClient, userId: string) {
  return prisma.wallet.findFirstOrThrow({ where: { userId } });
}
