import { randomUUID } from 'node:crypto';
import type {
  AuthSession,
  AuthTokens,
  LanguageCode,
  LoginRequest,
  RegisterRequest,
  RegisterResponse,
  SessionUser,
} from '@tw/contracts';
import { DEFAULT_CURRENCY } from '@tw/money';
import { writeAudit } from '../../core/audit/audit';
import type { PasswordBreachCheck } from '../../core/auth/breached-passwords';
import {
  burnPasswordVerification,
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from '../../core/auth/password';
import { generateOpaqueToken, hashToken, type TokenService } from '../../core/auth/tokens';
import type { AuditContext } from '../../core/context/request-context';
import { type Db, isUniqueViolation, type PrismaClient } from '../../core/db/prisma';
import { AppError } from '../../core/errors/app-error';
import { enqueueOutbox } from '../../core/outbox/outbox';
import type { SettingsService } from '../admin/settings.service';

/** A rotated refresh token presented again within this window re-issues instead of revoking. */
export const REFRESH_REUSE_GRACE_MS = 20_000;
export const PASSWORD_RESET_TTL_MS = 30 * 60_000;
export const EMAIL_VERIFICATION_TTL_MS = 48 * 60 * 60_000;

export interface AuthServiceConfig {
  refreshTokenTtlDays: number;
  appLinkBase: string;
  /** Rejects passwords known from data breaches. Omitted in tests and local development. */
  breachCheck?: PasswordBreachCheck | undefined;
}

interface SessionUserRecord {
  id: string;
  email: string;
  role: 'ADMIN' | 'USER';
  status: 'PENDING_APPROVAL' | 'ACTIVE' | 'INACTIVE';
  tokenVersion: number;
  emailVerifiedAt: Date | null;
  profile: { firstName: string; lastName: string; preferredLanguage: string } | null;
}

export const SESSION_USER_SELECT = {
  id: true,
  email: true,
  role: true,
  status: true,
  tokenVersion: true,
  emailVerifiedAt: true,
  profile: { select: { firstName: true, lastName: true, preferredLanguage: true } },
} as const;

export function toLanguage(value: string | undefined): LanguageCode {
  return value === 'nl' ? 'nl' : 'en';
}

export function toSessionUser(user: SessionUserRecord): SessionUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    emailVerified: user.emailVerifiedAt !== null,
    firstName: user.profile?.firstName ?? '',
    lastName: user.profile?.lastName ?? '',
    preferredLanguage: toLanguage(user.profile?.preferredLanguage),
  };
}

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly tokens: TokenService,
    private readonly settings: SettingsService,
    private readonly config: AuthServiceConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── Registration ──────────────────────────────────────────────────────────

  /** ASVS 2.1.7: a new password must not be one that attackers already have in their lists. */
  private async assertNotBreached(password: string): Promise<void> {
    if (await this.config.breachCheck?.isBreached(password)) {
      throw new AppError('PASSWORD_BREACHED', 'Password appears in a known data breach');
    }
  }

  async register(input: RegisterRequest, ctx: AuditContext): Promise<RegisterResponse> {
    await this.assertNotBreached(input.password);
    const requireApproval = await this.settings.get('registration.requireApproval');
    const passwordHash = await hashPassword(input.password);
    const status = requireApproval ? 'PENDING_APPROVAL' : 'ACTIVE';

    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: input.email,
            passwordHash,
            role: 'USER',
            status,
            profile: {
              create: {
                firstName: input.firstName,
                lastName: input.lastName,
                phone: input.phone ?? null,
                preferredLanguage: input.preferredLanguage,
              },
            },
            wallets: { create: { currency: DEFAULT_CURRENCY } },
          },
          select: SESSION_USER_SELECT,
        });

        await this.sendVerificationEmail(tx, user);
        await writeAudit(tx, ctx, {
          action: 'auth.register',
          entityType: 'User',
          entityId: user.id,
          actorId: user.id,
          after: { status, preferredLanguage: input.preferredLanguage },
        });

        if (status === 'PENDING_APPROVAL') return { status: 'PENDING_APPROVAL' as const };
        const tokens = await this.issueSession(tx, user, ctx);
        return { status: 'ACTIVE' as const, user: toSessionUser(user), tokens };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'email')) {
        throw new AppError('EMAIL_ALREADY_REGISTERED', 'Email address is already registered');
      }
      throw error;
    }
  }

  // ── Login / sessions ──────────────────────────────────────────────────────

  async login(input: LoginRequest, ctx: AuditContext): Promise<AuthSession> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { ...SESSION_USER_SELECT, passwordHash: true, deletedAt: true },
    });

    if (!user || user.deletedAt) {
      await burnPasswordVerification(input.password);
      await writeAudit(this.prisma, ctx, {
        action: 'auth.login_failed',
        entityType: 'User',
        actorId: null,
        after: { reason: 'unknown_account' },
      });
      throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password');
    }

    if (!(await verifyPassword(user.passwordHash, input.password))) {
      await writeAudit(this.prisma, ctx, {
        action: 'auth.login_failed',
        entityType: 'User',
        entityId: user.id,
        actorId: null,
        after: { reason: 'wrong_password' },
      });
      throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // Status is only revealed after the password is proven, to the account owner.
    if (user.status === 'INACTIVE') {
      throw new AppError('ACCOUNT_INACTIVE', 'Account is inactive');
    }
    if (user.status === 'PENDING_APPROVAL') {
      throw new AppError('ACCOUNT_PENDING_APPROVAL', 'Account is awaiting approval');
    }

    const newHash = passwordNeedsRehash(user.passwordHash)
      ? await hashPassword(input.password)
      : undefined;

    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { lastLoginAt: this.now(), ...(newHash ? { passwordHash: newHash } : {}) },
      });
      const tokens = await this.issueSession(tx, user, ctx);
      await writeAudit(tx, ctx, {
        action: 'auth.login',
        entityType: 'User',
        entityId: user.id,
        actorId: user.id,
      });
      return { user: toSessionUser(user), tokens };
    });
  }

  /**
   * Refresh-token rotation with reuse detection:
   *  - valid, unused token → revoked and replaced by a new one (same family)
   *  - an already-rotated token → the whole family is revoked (likely theft), unless it is
   *    presented again within REFRESH_REUSE_GRACE_MS and its successor was never used
   *    (lost response / app killed mid-refresh): then the successor is swapped for a new token.
   */
  async refresh(rawToken: string, ctx: AuditContext): Promise<AuthSession> {
    const tokenHash = hashToken(rawToken);
    const outcome = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM refresh_tokens WHERE token_hash = ${tokenHash} FOR UPDATE`;
      const lockedId = locked[0]?.id;
      if (!lockedId) return { kind: 'invalid' as const };

      const current = await tx.refreshToken.findUniqueOrThrow({
        where: { id: lockedId },
        include: { user: { select: { ...SESSION_USER_SELECT, deletedAt: true } } },
      });
      const now = this.now();

      if (current.revokedAt) {
        const inGrace =
          current.replacedById !== null &&
          now.getTime() - current.revokedAt.getTime() < REFRESH_REUSE_GRACE_MS;
        if (inGrace && current.replacedById) {
          const successor = await tx.refreshToken.findUnique({
            where: { id: current.replacedById },
          });
          if (successor && !successor.revokedAt && this.userMaySignIn(current.user)) {
            const { tokens, refreshTokenId } = await this.createSession(
              tx,
              current.user,
              ctx,
              current.familyId,
            );
            await tx.refreshToken.update({
              where: { id: successor.id },
              data: { revokedAt: now, replacedById: refreshTokenId },
            });
            return { kind: 'ok' as const, user: current.user, tokens };
          }
        }
        await tx.refreshToken.updateMany({
          where: { familyId: current.familyId, revokedAt: null },
          data: { revokedAt: now },
        });
        await writeAudit(tx, ctx, {
          action: 'auth.refresh_reuse_detected',
          entityType: 'User',
          entityId: current.userId,
          actorId: null,
          after: { familyId: current.familyId },
        });
        return { kind: 'reused' as const };
      }

      if (current.expiresAt <= now) return { kind: 'invalid' as const };
      if (current.user.deletedAt) return { kind: 'invalid' as const };
      if (current.user.status === 'INACTIVE') return { kind: 'inactive' as const };
      if (current.user.status === 'PENDING_APPROVAL') return { kind: 'pending' as const };

      const { tokens, refreshTokenId } = await this.createSession(
        tx,
        current.user,
        ctx,
        current.familyId,
      );
      await tx.refreshToken.update({
        where: { id: current.id },
        data: { revokedAt: now, replacedById: refreshTokenId },
      });
      return { kind: 'ok' as const, user: current.user, tokens };
    });

    switch (outcome.kind) {
      case 'ok':
        return { user: toSessionUser(outcome.user), tokens: outcome.tokens };
      case 'inactive':
        throw new AppError('ACCOUNT_INACTIVE', 'Account is inactive');
      case 'pending':
        throw new AppError('ACCOUNT_PENDING_APPROVAL', 'Account is awaiting approval');
      case 'reused':
      case 'invalid':
        throw new AppError('UNAUTHENTICATED', 'Invalid refresh token');
    }
  }

  /** Ends one login session (refresh-token family). The short-lived access token expires on its own. */
  async logout(sessionId: string, ctx: AuditContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.updateMany({
        where: { familyId: sessionId, revokedAt: null },
        data: { revokedAt: this.now() },
      });
      await writeAudit(tx, ctx, {
        action: 'auth.logout',
        entityType: 'User',
        entityId: ctx.actor?.id ?? null,
      });
    });
  }

  /** Invalidates every session, including outstanding access tokens (token version bump). */
  async logoutAll(userId: string, ctx: AuditContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.revokeAllSessions(tx, userId);
      await writeAudit(tx, ctx, {
        action: 'auth.logout_all',
        entityType: 'User',
        entityId: userId,
      });
    });
  }

  // ── Password reset ────────────────────────────────────────────────────────

  /** Always succeeds from the caller's perspective (no account enumeration). */
  async forgotPassword(email: string, ctx: AuditContext): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { ...SESSION_USER_SELECT, deletedAt: true },
    });
    if (!user || user.deletedAt || user.status !== 'ACTIVE') return;

    const rawToken = generateOpaqueToken();
    await this.prisma.$transaction(async (tx) => {
      // Only the newest link works.
      await tx.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });
      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(rawToken),
          expiresAt: new Date(this.now().getTime() + PASSWORD_RESET_TTL_MS),
        },
      });
      await enqueueOutbox(tx, 'email.send', {
        to: user.email,
        template: 'resetPassword',
        language: toLanguage(user.profile?.preferredLanguage),
        params: {
          firstName: user.profile?.firstName ?? '',
          link: this.link('reset-password', rawToken),
        },
      });
      await writeAudit(tx, ctx, {
        action: 'auth.password_reset_requested',
        entityType: 'User',
        entityId: user.id,
        actorId: null,
      });
    });
  }

  async resetPassword(rawToken: string, newPassword: string, ctx: AuditContext): Promise<void> {
    await this.assertNotBreached(newPassword);
    const passwordHash = await hashPassword(newPassword);
    const now = this.now();

    await this.prisma.$transaction(async (tx) => {
      const token = await tx.passwordResetToken.findUnique({
        where: { tokenHash: hashToken(rawToken) },
        include: { user: { select: { ...SESSION_USER_SELECT, deletedAt: true } } },
      });
      if (!token || token.usedAt || token.expiresAt <= now || token.user.deletedAt) {
        throw new AppError('INVALID_TOKEN', 'Reset link is invalid or expired');
      }
      // Conditional update: a concurrent second use of the same token loses the race.
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: token.id, usedAt: null },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) throw new AppError('INVALID_TOKEN', 'Reset link was already used');

      await tx.user.update({ where: { id: token.userId }, data: { passwordHash } });
      await this.revokeAllSessions(tx, token.userId);
      await enqueueOutbox(tx, 'email.send', {
        to: token.user.email,
        template: 'passwordChanged',
        language: toLanguage(token.user.profile?.preferredLanguage),
        params: { firstName: token.user.profile?.firstName ?? '' },
      });
      await writeAudit(tx, ctx, {
        action: 'auth.password_reset',
        entityType: 'User',
        entityId: token.userId,
        actorId: token.userId,
      });
    });
  }

  // ── Email verification ────────────────────────────────────────────────────

  async verifyEmail(rawToken: string, ctx: AuditContext): Promise<void> {
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      const token = await tx.emailVerificationToken.findUnique({
        where: { tokenHash: hashToken(rawToken) },
      });
      if (!token || token.usedAt || token.expiresAt <= now) {
        throw new AppError('INVALID_TOKEN', 'Verification link is invalid or expired');
      }
      const consumed = await tx.emailVerificationToken.updateMany({
        where: { id: token.id, usedAt: null },
        data: { usedAt: now },
      });
      if (consumed.count !== 1)
        throw new AppError('INVALID_TOKEN', 'Verification link was already used');

      await tx.user.updateMany({
        where: { id: token.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
      await writeAudit(tx, ctx, {
        action: 'auth.email_verified',
        entityType: 'User',
        entityId: token.userId,
        actorId: token.userId,
      });
    });
  }

  async resendVerification(userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: SESSION_USER_SELECT,
      });
      if (user.emailVerifiedAt) return;
      await tx.emailVerificationToken.deleteMany({ where: { userId, usedAt: null } });
      await this.sendVerificationEmail(tx, user);
    });
  }

  /**
   * Changes the password after re-checking the current one. Every other session (and every
   * outstanding access token) is revoked; the caller gets a fresh session for this device.
   */
  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
    ctx: AuditContext,
  ): Promise<AuthSession> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ...SESSION_USER_SELECT, passwordHash: true },
    });
    if (!user) throw AppError.notFound('User');
    if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
      await writeAudit(this.prisma, ctx, {
        action: 'auth.password_change_failed',
        entityType: 'User',
        entityId: userId,
      });
      throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect');
    }
    await this.assertNotBreached(input.newPassword);
    const passwordHash = await hashPassword(input.newPassword);

    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await this.revokeAllSessions(tx, userId);
      const updated = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: SESSION_USER_SELECT,
      });
      const tokens = await this.issueSession(tx, updated, ctx);
      await enqueueOutbox(tx, 'email.send', {
        to: updated.email,
        template: 'passwordChanged',
        language: toLanguage(updated.profile?.preferredLanguage),
        params: { firstName: updated.profile?.firstName ?? '' },
      });
      await writeAudit(tx, ctx, {
        action: 'auth.password_changed',
        entityType: 'User',
        entityId: userId,
      });
      return { user: toSessionUser(updated), tokens };
    });
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  async getSessionUser(userId: string): Promise<SessionUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: SESSION_USER_SELECT,
    });
    if (!user) throw AppError.notFound('User');
    return toSessionUser(user);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private userMaySignIn(user: { status: string; deletedAt: Date | null }): boolean {
    return user.status === 'ACTIVE' && user.deletedAt === null;
  }

  private async issueSession(
    db: Db,
    user: SessionUserRecord,
    ctx: AuditContext,
  ): Promise<AuthTokens> {
    const { tokens } = await this.createSession(db, user, ctx, randomUUID());
    return tokens;
  }

  private async createSession(
    db: Db,
    user: Pick<SessionUserRecord, 'id' | 'role' | 'tokenVersion'>,
    ctx: AuditContext,
    familyId: string,
  ): Promise<{ tokens: AuthTokens; refreshTokenId: string }> {
    const refreshToken = generateOpaqueToken();
    const refreshExpiresAt = new Date(
      this.now().getTime() + this.config.refreshTokenTtlDays * 24 * 60 * 60_000,
    );
    const row = await db.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshExpiresAt,
        userAgent: ctx.userAgent,
        ipAddress: ctx.ip,
      },
      select: { id: true },
    });
    const access = await this.tokens.signAccessToken({
      userId: user.id,
      role: user.role,
      sessionId: familyId,
      tokenVersion: user.tokenVersion,
    });
    return {
      refreshTokenId: row.id,
      tokens: {
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt.toISOString(),
        refreshToken,
        refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
      },
    };
  }

  private async revokeAllSessions(db: Db, userId: string): Promise<void> {
    await db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
    await db.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
    // Signed-out phones must stop receiving pushes; a device still signed in re-registers.
    await db.deviceToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }

  private async sendVerificationEmail(db: Db, user: SessionUserRecord): Promise<void> {
    const rawToken = generateOpaqueToken();
    await db.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(this.now().getTime() + EMAIL_VERIFICATION_TTL_MS),
      },
    });
    await enqueueOutbox(db, 'email.send', {
      to: user.email,
      template: 'verifyEmail',
      language: toLanguage(user.profile?.preferredLanguage),
      params: {
        firstName: user.profile?.firstName ?? '',
        link: this.link('verify-email', rawToken),
      },
    });
  }

  private link(path: string, token: string): string {
    return `${this.config.appLinkBase}${path}?token=${encodeURIComponent(token)}`;
  }
}
