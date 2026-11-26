import type { PrismaClient } from '../core/db/prisma';
import {
  REVOKED_DEVICE_RETENTION_MS,
  STALE_DEVICE_MS,
} from '../modules/notifications/devices.service';

const DAY_MS = 24 * 60 * 60_000;
/** Expired/consumed credentials are kept briefly for incident investigation, then purged. */
export const CREDENTIAL_RETENTION_MS = 7 * DAY_MS;
export const OUTBOX_RETENTION_MS = 7 * DAY_MS;
/** Push delivery rows are diagnostics only. */
export const DELIVERY_RETENTION_MS = 90 * DAY_MS;

export interface MaintenanceResult {
  idempotencyRecords: number;
  refreshTokens: number;
  passwordResetTokens: number;
  emailVerificationTokens: number;
  outboxEvents: number;
  /** Tokens the app stopped re-registering (revoked). */
  staleDevices: number;
  /** Revoked tokens purged after the retention period, with their delivery rows. */
  devicesPurged: number;
  deliveriesPurged: number;
}

/**
 * Purges expired non-financial records. Never touches ledger, payments, charges, debts or
 * audit logs (those are retained; the database also forbids deleting them).
 */
export async function runMaintenance(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<MaintenanceResult> {
  const credentialCutoff = new Date(now.getTime() - CREDENTIAL_RETENTION_MS);
  const outboxCutoff = new Date(now.getTime() - OUTBOX_RETENTION_MS);

  const [
    idempotencyRecords,
    refreshTokens,
    passwordResetTokens,
    emailVerificationTokens,
    outboxEvents,
  ] = await Promise.all([
    prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.refreshToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: credentialCutoff } }, { revokedAt: { lt: credentialCutoff } }],
      },
    }),
    prisma.passwordResetToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: credentialCutoff } }, { usedAt: { lt: credentialCutoff } }],
      },
    }),
    prisma.emailVerificationToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: credentialCutoff } }, { usedAt: { lt: credentialCutoff } }],
      },
    }),
    prisma.outboxEvent.deleteMany({ where: { processedAt: { lt: outboxCutoff } } }),
  ]);

  // Push devices: revoke abandoned tokens, then purge old deliveries and long-revoked tokens.
  const staleDevices = await prisma.deviceToken.updateMany({
    where: { revokedAt: null, lastSeenAt: { lt: new Date(now.getTime() - STALE_DEVICE_MS) } },
    data: { revokedAt: now },
  });
  const purgeable = await prisma.deviceToken.findMany({
    where: { revokedAt: { lt: new Date(now.getTime() - REVOKED_DEVICE_RETENTION_MS) } },
    select: { id: true },
  });
  const purgeIds = purgeable.map((d) => d.id);
  const deliveriesPurged = await prisma.notificationDelivery.deleteMany({
    where: {
      OR: [
        { attemptedAt: { lt: new Date(now.getTime() - DELIVERY_RETENTION_MS) } },
        { deviceTokenId: { in: purgeIds } },
      ],
    },
  });
  const devicesPurged = await prisma.deviceToken.deleteMany({ where: { id: { in: purgeIds } } });

  return {
    idempotencyRecords: idempotencyRecords.count,
    refreshTokens: refreshTokens.count,
    passwordResetTokens: passwordResetTokens.count,
    emailVerificationTokens: emailVerificationTokens.count,
    outboxEvents: outboxEvents.count,
    staleDevices: staleDevices.count,
    devicesPurged: devicesPurged.count,
    deliveriesPurged: deliveriesPurged.count,
  };
}
