import { createHash } from 'node:crypto';
import { IDEMPOTENCY_HEADER, IdempotencyKeySchema } from '@tw/contracts';
import type { RequestHandler, Response } from 'express';
import { isUniqueViolation, type Prisma, type PrismaClient } from '../db/prisma';
import { AppError } from '../errors/app-error';

export interface IdempotencyOptions {
  /** Money-moving endpoints must send the header; others may. */
  required: boolean;
  /** How long a stored response can be replayed. */
  ttlMs?: number;
  /** How long an in-flight request holds the key before another attempt may take over. */
  lockMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_LOCK_MS = 60_000;

/** Key-order-independent JSON so semantically equal bodies hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Idempotency-Key handling (per authenticated actor):
 *  - first request: reserves the key, runs the handler, stores the response (status < 500)
 *  - same key + same request: replays the stored response (header Idempotent-Replayed: true)
 *  - same key + different request: 409 IDEMPOTENCY_KEY_REUSED
 *  - same key while the first is still running: 409 IDEMPOTENCY_IN_PROGRESS
 *  - 5xx responses are not stored, so the client can retry safely.
 *
 * This is the HTTP-level guard. Financial writes ALSO carry a unique ledger idempotency key,
 * which covers the gap where the business transaction committed but storing the response failed.
 * Mount after `authenticate`.
 */
export function idempotency(prisma: PrismaClient, options: IdempotencyOptions): RequestHandler {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const lockMs = options.lockMs ?? DEFAULT_LOCK_MS;

  return async (req, res, next) => {
    const actor = req.context.actor;
    if (!actor) throw AppError.unauthenticated();

    const rawKey = req.get(IDEMPOTENCY_HEADER);
    if (rawKey === undefined) {
      if (options.required) {
        throw AppError.validation(
          { header: IDEMPOTENCY_HEADER },
          'Idempotency-Key header is required',
        );
      }
      next();
      return;
    }
    const parsedKey = IdempotencyKeySchema.safeParse(rawKey);
    if (!parsedKey.success) {
      throw AppError.validation({ header: IDEMPOTENCY_HEADER }, 'Malformed Idempotency-Key header');
    }
    const key = parsedKey.data;
    const path = req.baseUrl + req.path;
    const requestHash = createHash('sha256')
      .update(`${req.method} ${path}\n${canonicalJson(req.body)}`)
      .digest('hex');
    const now = new Date();

    let recordId: string;
    try {
      const created = await prisma.idempotencyRecord.create({
        data: {
          actorId: actor.id,
          key,
          method: req.method,
          path,
          requestHash,
          lockedUntil: new Date(now.getTime() + lockMs),
          expiresAt: new Date(now.getTime() + ttlMs),
        },
        select: { id: true },
      });
      recordId = created.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await prisma.idempotencyRecord.findUnique({
        where: { actorId_key: { actorId: actor.id, key } },
      });
      if (!existing) throw new AppError('IDEMPOTENCY_IN_PROGRESS', 'Please retry');

      if (existing.requestHash !== requestHash) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key was used for a different request',
        );
      }
      if (existing.responseStatus !== null) {
        res.setHeader('Idempotent-Replayed', 'true');
        res.status(existing.responseStatus).json(existing.responseBody);
        return;
      }
      if (existing.lockedUntil && existing.lockedUntil > now) {
        throw new AppError(
          'IDEMPOTENCY_IN_PROGRESS',
          'A request with this Idempotency-Key is in progress',
        );
      }
      // Stale lock (the earlier attempt crashed): take over atomically.
      const takeover = await prisma.idempotencyRecord.updateMany({
        where: { id: existing.id, lockedUntil: existing.lockedUntil, responseStatus: null },
        data: { lockedUntil: new Date(now.getTime() + lockMs) },
      });
      if (takeover.count === 0) {
        throw new AppError(
          'IDEMPOTENCY_IN_PROGRESS',
          'A request with this Idempotency-Key is in progress',
        );
      }
      recordId = existing.id;
    }

    interceptJson(
      res,
      async (status, body) => {
        if (status >= 500) {
          await prisma.idempotencyRecord.delete({ where: { id: recordId } });
          return;
        }
        await prisma.idempotencyRecord.update({
          where: { id: recordId },
          data: {
            responseStatus: status,
            responseBody: (body ?? null) as Prisma.InputJsonValue,
            lockedUntil: null,
          },
        });
      },
      (error) => req.log.error({ err: error }, 'failed to persist idempotent response'),
    );

    next();
  };
}

/**
 * Persists the response BEFORE it is sent, so an immediate client retry already sees it.
 */
function interceptJson(
  res: Response,
  persist: (status: number, body: unknown) => Promise<void>,
  onError: (error: unknown) => void,
): void {
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    persist(res.statusCode, body)
      .catch(onError)
      .finally(() => {
        originalJson(body);
      });
    return res;
  };
}
