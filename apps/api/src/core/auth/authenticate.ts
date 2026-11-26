import { type Role, VIEW_SESSION_HEADER } from '@tw/contracts';
import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { writeAudit } from '../audit/audit';
import { auditContextOf } from '../context/request-context';
import type { PrismaClient } from '../db/prisma';
import { AppError } from '../errors/app-error';
import type { TokenService } from './tokens';

const BEARER = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UuidSchema = z.uuid();

export interface AuthenticateDeps {
  tokens: TokenService;
  prisma: PrismaClient;
  now?: () => Date;
}

/**
 * Verifies the access token AND re-checks the user in the database on every request, so
 * deactivation, deletion, role changes and "log out everywhere" take effect immediately
 * instead of after the token expires. One primary-key lookup per request.
 *
 * With an X-View-Session header (admins only), `subject` becomes the viewed user while
 * `actor` stays the admin, the request is marked read-only, and the read is audited.
 */
export function authenticate(deps: AuthenticateDeps): RequestHandler {
  const now = deps.now ?? (() => new Date());

  return async (req, _res, next) => {
    const header = req.get('authorization');
    const match = header ? BEARER.exec(header) : null;
    if (!match?.[1]) throw AppError.unauthenticated();

    const claims = await deps.tokens.verifyAccessToken(match[1]);
    const user = await deps.prisma.user.findUnique({
      where: { id: claims.userId },
      select: { id: true, role: true, status: true, tokenVersion: true, deletedAt: true },
    });

    if (!user || user.deletedAt || user.tokenVersion !== claims.tokenVersion) {
      throw new AppError('UNAUTHENTICATED', 'Session is no longer valid');
    }
    if (user.status === 'INACTIVE') {
      throw new AppError('ACCOUNT_INACTIVE', 'Account is inactive');
    }
    if (user.status === 'PENDING_APPROVAL') {
      throw new AppError('ACCOUNT_PENDING_APPROVAL', 'Account is awaiting approval');
    }

    // The database role wins over the token claim (role changes apply immediately).
    req.context.actor = { id: user.id, role: user.role };
    req.context.subject = { id: user.id };
    req.context.sessionId = claims.sessionId;

    const viewSessionId = req.get(VIEW_SESSION_HEADER);
    if (viewSessionId !== undefined) {
      await enterViewMode(req, deps.prisma, viewSessionId, now());
    }
    next();
  };
}

async function enterViewMode(
  req: Request,
  prisma: PrismaClient,
  viewSessionId: string,
  now: Date,
): Promise<void> {
  const actor = req.context.actor;
  if (actor?.role !== 'ADMIN') {
    throw AppError.forbidden('View as user is only available to administrators');
  }
  // Defence in depth: the global guard already rejects unsafe methods in view mode.
  if (!SAFE_METHODS.has(req.method)) {
    throw new AppError('VIEW_AS_READ_ONLY', 'View as user is read-only');
  }
  if (!UuidSchema.safeParse(viewSessionId).success) {
    throw new AppError('VIEW_SESSION_INVALID', 'Unknown view session');
  }
  const session = await prisma.viewSession.findFirst({
    where: { id: viewSessionId, adminId: actor.id },
    select: {
      id: true,
      subjectUserId: true,
      expiresAt: true,
      endedAt: true,
      subject: { select: { deletedAt: true, role: true } },
    },
  });
  if (
    !session ||
    session.endedAt !== null ||
    session.expiresAt <= now ||
    session.subject.deletedAt !== null ||
    session.subject.role !== 'USER'
  ) {
    throw new AppError('VIEW_SESSION_INVALID', 'View session has ended or is not yours');
  }

  req.context.subject = { id: session.subjectUserId };
  req.context.viewSessionId = session.id;
  req.context.readOnly = true;

  await writeAudit(prisma, auditContextOf(req), {
    action: 'view_session.read',
    entityType: 'User',
    entityId: session.subjectUserId,
    after: { method: req.method, path: req.baseUrl + req.path },
  });
}

/**
 * Global, default-deny: a request carrying a view-session header may only read.
 * Mounted before all routers, so it also covers routes that never authenticate.
 * (Ending a view session is a DELETE sent WITHOUT the header.)
 */
export const viewAsReadOnlyGuard: RequestHandler = (req, _res, next) => {
  if (req.get(VIEW_SESSION_HEADER) !== undefined && !SAFE_METHODS.has(req.method)) {
    throw new AppError('VIEW_AS_READ_ONLY', 'View as user is read-only');
  }
  next();
};

/** For GET endpoints that must not be available while viewing as a user (e.g. data export). */
export const forbidInViewMode: RequestHandler = (req, _res, next) => {
  if (req.context.readOnly) {
    throw new AppError('VIEW_AS_READ_ONLY', 'Not available while viewing as a user');
  }
  next();
};

/** Authorization by role. Mount after `authenticate`. */
export function requireRole(...roles: [Role, ...Role[]]): RequestHandler {
  return (req, _res, next) => {
    const actor = req.context.actor;
    if (!actor) throw AppError.unauthenticated();
    if (!roles.includes(actor.role)) throw AppError.forbidden('Insufficient role');
    next();
  };
}
