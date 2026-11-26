import type { Role } from '@tw/contracts';
import type { Request, RequestHandler } from 'express';
import { AppError } from '../errors/app-error';
import { getRequestId } from '../http/request-logging';

export interface Actor {
  id: string;
  role: Role;
}

/**
 * Per-request identity and metadata.
 *  - actor:   who is authenticated (never replaced, also not in View-as mode)
 *  - subject: whose data "/me" endpoints operate on (= actor, or the viewed user in View-as)
 */
export interface RequestContext {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  actor: Actor | null;
  subject: { id: string } | null;
  sessionId: string | null;
  viewSessionId: string | null;
  readOnly: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    context: RequestContext;
  }
}

export const requestContext: RequestHandler = (req, _res, next) => {
  const userAgent = req.get('user-agent');
  req.context = {
    requestId: getRequestId(req),
    ip: req.ip ?? null,
    userAgent: userAgent ? userAgent.slice(0, 512) : null,
    actor: null,
    subject: null,
    sessionId: null,
    viewSessionId: null,
    readOnly: false,
  };
  next();
};

export function requireActor(req: Request): Actor {
  if (!req.context.actor) throw AppError.unauthenticated();
  return req.context.actor;
}

/** The user whose data a "/me" endpoint reads or writes. */
export function requireSubjectId(req: Request): string {
  if (!req.context.subject) throw AppError.unauthenticated();
  return req.context.subject.id;
}

/** Metadata recorded with audit entries and outbox events. */
export interface AuditContext {
  actor: Actor | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  viewSessionId: string | null;
}

export function auditContextOf(req: Request): AuditContext {
  const { actor, requestId, ip, userAgent, viewSessionId } = req.context;
  return { actor, requestId, ip, userAgent, viewSessionId };
}

export const SYSTEM_CONTEXT: AuditContext = {
  actor: null,
  requestId: null,
  ip: null,
  userAgent: null,
  viewSessionId: null,
};
