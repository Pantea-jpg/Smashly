import { randomUUID } from 'node:crypto';
import {
  AVATAR_CONTENT_TYPES,
  AVATAR_MAX_BYTES,
  type AvatarUploadUrl,
  type AvatarUploadUrlRequest,
  NotificationCategory,
  type NotificationPreference,
  type Profile,
  type UpdateProfileRequest,
} from '@tw/contracts';
import { writeAudit } from '../../core/audit/audit';
import { generateOpaqueToken } from '../../core/auth/tokens';
import { hashPassword, verifyPassword } from '../../core/auth/password';
import type { AuditContext } from '../../core/context/request-context';
import type { PrismaClient } from '../../core/db/prisma';
import { AppError } from '../../core/errors/app-error';
import type { Logger } from '../../core/logger/logger';
import type { ObjectStorage } from '../../integrations/storage/object-storage';
import { toLanguage } from '../auth/auth.service';
import { avatarObjectPrefix, avatarUrl } from '../users/avatar';

const AVATAR_UPLOAD_TTL_SECONDS = 5 * 60;
const EXTENSION: Record<(typeof AVATAR_CONTENT_TYPES)[number], string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export class ProfileService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: ObjectStorage,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getProfile(userId: string): Promise<Profile> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });
    if (!user || user.deletedAt) throw AppError.notFound('User');
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      emailVerified: user.emailVerifiedAt !== null,
      firstName: user.profile?.firstName ?? '',
      lastName: user.profile?.lastName ?? '',
      phone: user.profile?.phone ?? null,
      avatarUrl: await avatarUrl(this.storage, user.profile?.avatarKey),
      preferredLanguage: toLanguage(user.profile?.preferredLanguage),
      createdAt: user.createdAt.toISOString(),
    };
  }

  async updateProfile(
    userId: string,
    input: UpdateProfileRequest,
    ctx: AuditContext,
  ): Promise<Profile> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.userProfile.findUniqueOrThrow({ where: { userId } });
      const data = {
        ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
        ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.preferredLanguage !== undefined
          ? { preferredLanguage: input.preferredLanguage }
          : {}),
      };
      await tx.userProfile.update({ where: { userId }, data });
      await writeAudit(tx, ctx, {
        action: 'profile.updated',
        entityType: 'User',
        entityId: userId,
        // Field names only: profile values are personal data and stay out of the audit log.
        after: { fields: Object.keys(data) },
        before: { fields: Object.keys(data).filter((k) => k in before) },
      });
    });
    return this.getProfile(userId);
  }

  // ── Notification preferences ────────────────────────────────────────────

  /** Every category, defaulting to push enabled when the user never changed it. */
  async getPreferences(userId: string): Promise<NotificationPreference[]> {
    const rows = await this.prisma.notificationPreference.findMany({ where: { userId } });
    const stored = new Map(rows.map((row) => [row.category, row.pushEnabled]));
    return NotificationCategory.options.map((category) => ({
      category,
      pushEnabled: stored.get(category) ?? true,
    }));
  }

  async updatePreferences(
    userId: string,
    preferences: NotificationPreference[],
  ): Promise<NotificationPreference[]> {
    await this.prisma.$transaction(
      preferences.map((preference) =>
        this.prisma.notificationPreference.upsert({
          where: { userId_category: { userId, category: preference.category } },
          create: { userId, ...preference },
          update: { pushEnabled: preference.pushEnabled },
        }),
      ),
    );
    return this.getPreferences(userId);
  }

  // ── Profile picture ─────────────────────────────────────────────────────

  /** Step 1: a presigned PUT for one new object under the user's own prefix. */
  async createAvatarUpload(
    userId: string,
    input: AvatarUploadUrlRequest,
  ): Promise<AvatarUploadUrl> {
    const objectKey = `${avatarObjectPrefix(userId)}${randomUUID()}.${EXTENSION[input.contentType]}`;
    const { url, headers } = await this.storage.presignPut(objectKey, {
      contentType: input.contentType,
      contentLength: input.sizeBytes,
      expiresInSeconds: AVATAR_UPLOAD_TTL_SECONDS,
    });
    return {
      uploadUrl: url,
      objectKey,
      headers,
      expiresAt: new Date(this.now().getTime() + AVATAR_UPLOAD_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /** Step 2: after the client uploaded, verify the object and make it the profile picture. */
  async confirmAvatar(userId: string, objectKey: string, ctx: AuditContext): Promise<Profile> {
    if (!objectKey.startsWith(avatarObjectPrefix(userId)) || objectKey.includes('..')) {
      throw AppError.validation(
        { objectKey: 'not_yours' },
        'Object key does not belong to this user',
      );
    }
    const metadata = await this.storage.head(objectKey);
    if (!metadata) {
      throw AppError.validation({ objectKey: 'not_uploaded' }, 'Upload not found');
    }
    const typeOk = (AVATAR_CONTENT_TYPES as readonly string[]).includes(metadata.contentType ?? '');
    if (!typeOk || (metadata.contentLength ?? 0) > AVATAR_MAX_BYTES) {
      await this.storage.delete(objectKey);
      throw AppError.validation(
        { objectKey: 'invalid_image' },
        'Uploaded file is not an accepted image',
      );
    }

    const previous = await this.prisma.$transaction(async (tx) => {
      const profile = await tx.userProfile.findUniqueOrThrow({ where: { userId } });
      await tx.userProfile.update({ where: { userId }, data: { avatarKey: objectKey } });
      await writeAudit(tx, ctx, {
        action: 'profile.avatar_changed',
        entityType: 'User',
        entityId: userId,
      });
      return profile.avatarKey;
    });
    if (previous && previous !== objectKey) await this.deleteObjectQuietly(previous);
    return this.getProfile(userId);
  }

  async removeAvatar(userId: string, ctx: AuditContext): Promise<Profile> {
    const previous = await this.prisma.$transaction(async (tx) => {
      const profile = await tx.userProfile.findUniqueOrThrow({ where: { userId } });
      if (!profile.avatarKey) return null;
      await tx.userProfile.update({ where: { userId }, data: { avatarKey: null } });
      await writeAudit(tx, ctx, {
        action: 'profile.avatar_removed',
        entityType: 'User',
        entityId: userId,
      });
      return profile.avatarKey;
    });
    if (previous) await this.deleteObjectQuietly(previous);
    return this.getProfile(userId);
  }

  // ── GDPR: export and deletion ───────────────────────────────────────────

  /** Everything stored about the user, without secrets (hashes, tokens, internal ids of others). */
  async exportData(userId: string, ctx: AuditContext): Promise<Record<string, unknown>> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        profile: true,
        notificationPrefs: true,
        wallets: true,
        transactions: { orderBy: { createdAt: 'asc' } },
        trainingCharges: true,
        debts: true,
        payments: true,
        reservations: true,
        attendances: true,
        notifications: { where: { deletedAt: null } },
        deviceTokens: {
          select: { platform: true, appVersion: true, createdAt: true, lastSeenAt: true },
        },
        refreshTokens: {
          select: {
            createdAt: true,
            expiresAt: true,
            revokedAt: true,
            userAgent: true,
            ipAddress: true,
          },
        },
      },
    });
    if (!user) throw AppError.notFound('User');
    await writeAudit(this.prisma, ctx, {
      action: 'profile.data_exported',
      entityType: 'User',
      entityId: userId,
    });

    const { passwordHash: _hash, tokenVersion: _tv, refreshTokens, profile, ...account } = user;
    return {
      exportedAt: this.now().toISOString(),
      account: {
        id: account.id,
        email: account.email,
        role: account.role,
        status: account.status,
        emailVerifiedAt: account.emailVerifiedAt,
        createdAt: account.createdAt,
        lastLoginAt: account.lastLoginAt,
      },
      profile: profile && {
        firstName: profile.firstName,
        lastName: profile.lastName,
        phone: profile.phone,
        preferredLanguage: profile.preferredLanguage,
        hasProfilePicture: profile.avatarKey !== null,
      },
      notificationPreferences: account.notificationPrefs.map(({ category, pushEnabled }) => ({
        category,
        pushEnabled,
      })),
      wallets: account.wallets,
      transactions: account.transactions,
      trainingCharges: account.trainingCharges,
      debts: account.debts,
      payments: account.payments,
      reservations: account.reservations,
      attendance: account.attendances,
      notifications: account.notifications,
      devices: account.deviceTokens,
      sessions: refreshTokens,
    };
  }

  /**
   * Deletes the account by anonymising personal data (Apple 5.1.1(v), GDPR art. 17).
   * Financial records stay (Dutch 7-year retention) and keep pointing at the same user id.
   * Refused while money is involved (D4), and for admins.
   */
  async deleteAccount(userId: string, password: string, ctx: AuditContext): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true, wallets: true },
    });
    if (!user || user.deletedAt) throw AppError.notFound('User');
    if (user.role === 'ADMIN') {
      throw AppError.forbidden('Admin accounts cannot be deleted from the app');
    }
    if (!(await verifyPassword(user.passwordHash, password))) {
      throw new AppError('INVALID_CREDENTIALS', 'Password is incorrect');
    }
    if (user.wallets.some((w) => w.balanceMinor > 0 || w.debtMinor > 0)) {
      throw new AppError(
        'ACCOUNT_HAS_BALANCE_OR_DEBT',
        'Settle the wallet balance and any outstanding debt before deleting the account',
      );
    }

    const now = this.now();
    // Unusable random hash: nobody can ever sign in to this account again.
    const unusableHash = await hashPassword(generateOpaqueToken());
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          email: `deleted+${userId}@deleted.invalid`,
          passwordHash: unusableHash,
          status: 'INACTIVE',
          deletedAt: now,
          anonymizedAt: now,
          tokenVersion: { increment: 1 },
          emailVerifiedAt: null,
        },
      });
      await tx.userProfile.update({
        where: { userId },
        data: { firstName: 'Deleted', lastName: 'user', phone: null, avatarKey: null },
      });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.deviceToken.deleteMany({ where: { userId } });
      await tx.notificationPreference.deleteMany({ where: { userId } });
      await tx.passwordResetToken.deleteMany({ where: { userId } });
      await tx.emailVerificationToken.deleteMany({ where: { userId } });
      await tx.viewSession.updateMany({
        where: { subjectUserId: userId, endedAt: null },
        data: { endedAt: now },
      });
      await writeAudit(tx, ctx, {
        action: 'user.account_deleted',
        entityType: 'User',
        entityId: userId,
      });
    });
    if (user.profile?.avatarKey) await this.deleteObjectQuietly(user.profile.avatarKey);
  }

  private async deleteObjectQuietly(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (err) {
      // An orphaned object is harmless (private bucket); a bucket lifecycle rule cleans up.
      this.logger.warn({ err, key }, 'failed to delete object from storage');
    }
  }
}
