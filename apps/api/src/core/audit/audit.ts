import type { AuditContext } from '../context/request-context';
import { type Db, Prisma } from '../db/prisma';

export interface AuditEntry {
  /** dot.case verb, e.g. auth.login, auth.login_failed, wallet.cash_top_up */
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  /** Overrides the context actor (e.g. a login, where the actor is only known afterwards). */
  actorId?: string | null;
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return value;
}

/**
 * Appends an audit entry. Pass the transaction client so the entry commits (or rolls back)
 * together with the change it describes. Never put secrets, tokens or password hashes in
 * `before`/`after`.
 */
export async function writeAudit(db: Db, ctx: AuditContext, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: entry.actorId === undefined ? (ctx.actor?.id ?? null) : entry.actorId,
      actorRole: ctx.actor?.role ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      viewSessionId: ctx.viewSessionId,
      requestId: ctx.requestId,
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
      before: toJson(entry.before),
      after: toJson(entry.after),
    },
  });
}
