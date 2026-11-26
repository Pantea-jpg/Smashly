import type { Device, RegisterDeviceRequest } from '@tw/contracts';
import type { PrismaClient } from '../../core/db/prisma';

/** Revoked tokens are kept this long (for delivery history), then purged by maintenance. */
export const REVOKED_DEVICE_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** A token the app has not re-registered for this long is treated as abandoned. */
export const STALE_DEVICE_MS = 90 * 24 * 60 * 60_000;

type DeviceRow = {
  id: string;
  platform: Device['platform'];
  provider: Device['provider'];
  appVersion: string | null;
  lastSeenAt: Date;
  createdAt: Date;
};

const toDevice = (d: DeviceRow): Device => ({
  id: d.id,
  platform: d.platform,
  provider: d.provider,
  appVersion: d.appVersion,
  lastSeenAt: d.lastSeenAt.toISOString(),
  createdAt: d.createdAt.toISOString(),
});

/**
 * Push device registration. The app registers its native APNs token after sign-in and on
 * every launch (keeping `lastSeenAt` fresh), and unregisters it before signing out.
 */
export class DevicesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Upsert by token. A token belongs to one phone, so registering it again (another member
   * signs in on the same phone) moves it to the current user and un-revokes it.
   */
  async register(
    userId: string,
    input: Required<Pick<RegisterDeviceRequest, 'token' | 'platform'>> &
      Pick<RegisterDeviceRequest, 'provider' | 'appVersion'>,
  ): Promise<Device> {
    const now = this.now();
    const data = {
      userId,
      platform: input.platform,
      provider: input.provider ?? 'APNS',
      appVersion: input.appVersion ?? null,
      lastSeenAt: now,
      revokedAt: null,
    };
    const row = await this.prisma.deviceToken.upsert({
      where: { token: input.token },
      create: { ...data, token: input.token },
      update: data,
    });
    return toDevice(row);
  }

  /** Only the owner can unregister; an unknown token is not an error (idempotent). */
  async unregister(userId: string, token: string): Promise<void> {
    await this.prisma.deviceToken.updateMany({
      where: { token: token.toLowerCase(), userId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }
}
