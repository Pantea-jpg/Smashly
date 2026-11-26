import type { ViewSession } from '@tw/contracts';
import { writeAudit } from '../../core/audit/audit';
import type { Actor, AuditContext } from '../../core/context/request-context';
import type { PrismaClient } from '../../core/db/prisma';
import { AppError } from '../../core/errors/app-error';
import type { AuthService } from '../auth/auth.service';

export const VIEW_SESSION_TTL_MS = 30 * 60_000;

/**
 * "View as User": an admin sees a user's app read-only. This creates an audited viewing
 * context, NOT a credential for the user. The admin stays authenticated as the admin, and
 * the API rejects every non-GET request that carries the view-session header.
 */
export class ViewSessionsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly auth: AuthService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(actor: Actor, userId: string, ctx: AuditContext): Promise<ViewSession> {
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, deletedAt: true },
    });
    if (!target || target.deletedAt) throw AppError.notFound('User');
    if (target.role !== 'USER') throw AppError.forbidden('Only user accounts can be viewed');

    const now = this.now();
    const session = await this.prisma.$transaction(async (tx) => {
      // One active view session per admin.
      await tx.viewSession.updateMany({
        where: { adminId: actor.id, endedAt: null },
        data: { endedAt: now },
      });
      const created = await tx.viewSession.create({
        data: {
          adminId: actor.id,
          subjectUserId: userId,
          expiresAt: new Date(now.getTime() + VIEW_SESSION_TTL_MS),
          ipAddress: ctx.ip,
        },
      });
      await writeAudit(
        tx,
        { ...ctx, viewSessionId: created.id },
        {
          action: 'view_session.started',
          entityType: 'User',
          entityId: userId,
        },
      );
      return created;
    });

    return {
      id: session.id,
      expiresAt: session.expiresAt.toISOString(),
      subject: await this.auth.getSessionUser(userId),
    };
  }

  async end(actor: Actor, sessionId: string, ctx: AuditContext): Promise<void> {
    const session = await this.prisma.viewSession.findFirst({
      where: { id: sessionId, adminId: actor.id },
    });
    if (!session) throw AppError.notFound('View session');
    if (session.endedAt) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.viewSession.update({ where: { id: session.id }, data: { endedAt: this.now() } });
      await writeAudit(
        tx,
        { ...ctx, viewSessionId: session.id },
        {
          action: 'view_session.ended',
          entityType: 'User',
          entityId: session.subjectUserId,
        },
      );
    });
  }
}
