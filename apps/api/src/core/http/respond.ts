import type { Request, Response } from 'express';
import type { z } from 'zod';
import { AppError } from '../errors/app-error';
import { getRequestId } from './request-logging';

/** `{ data, meta: { requestId } }` success envelope. */
export function sendData<T>(req: Request, res: Response, data: T, status = 200): void {
  res.status(status).json({ data, meta: { requestId: getRequestId(req) } });
}

export function sendCursorList<T>(
  req: Request,
  res: Response,
  items: T[],
  page: { nextCursor: string | null; hasMore: boolean },
): void {
  res.json({ data: items, meta: { requestId: getRequestId(req), page } });
}

export function sendOffsetList<T>(
  req: Request,
  res: Response,
  items: T[],
  page: { page: number; pageSize: number; total: number },
): void {
  res.json({ data: items, meta: { requestId: getRequestId(req), page } });
}

interface RequestSchemas<B extends z.ZodType, Q extends z.ZodType, P extends z.ZodType> {
  body?: B;
  query?: Q;
  params?: P;
}

type Parsed<S extends z.ZodType | undefined> = S extends z.ZodType ? z.output<S> : undefined;

/**
 * Validates request parts against Zod schemas and returns typed values.
 * Unknown keys are stripped (z.object default). Throws VALIDATION_ERROR with field details.
 */
export function parseRequest<
  B extends z.ZodType = never,
  Q extends z.ZodType = never,
  P extends z.ZodType = never,
>(
  req: Request,
  schemas: RequestSchemas<B, Q, P>,
): { body: Parsed<B>; query: Parsed<Q>; params: Parsed<P> } {
  const issues: Record<string, unknown> = {};
  const out: Record<string, unknown> = {};

  for (const part of ['body', 'query', 'params'] as const) {
    const schema = schemas[part];
    if (!schema) continue;
    const result = schema.safeParse(req[part]);
    if (result.success) {
      out[part] = result.data;
    } else {
      issues[part] = result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      }));
    }
  }

  if (Object.keys(issues).length > 0) {
    throw AppError.validation(issues);
  }
  return out as { body: Parsed<B>; query: Parsed<Q>; params: Parsed<P> };
}
