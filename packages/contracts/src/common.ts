import { CURRENCIES, type CurrencyCode } from '@tw/money';
import { z } from 'zod';

export const CurrencySchema = z.enum(Object.keys(CURRENCIES) as [CurrencyCode, ...CurrencyCode[]]);

/** Integer minor units. Upper bound keeps every per-row value inside a Postgres INT4. */
export const MinorUnitsSchema = z.number().int().min(-2_147_483_648).max(2_147_483_647);

export const MoneySchema = z.object({
  amountMinor: MinorUnitsSchema,
  currency: CurrencySchema,
});
export type MoneyDto = z.infer<typeof MoneySchema>;

export const IdSchema = z.uuid();
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

// ── Response envelopes ──────────────────────────────────────────────────────

export const ResponseMetaSchema = z.object({
  requestId: z.string(),
});

export const CursorPageSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export const OffsetPageSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
});

export function dataEnvelope<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: ResponseMetaSchema });
}

export function cursorListEnvelope<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    meta: ResponseMetaSchema.extend({ page: CursorPageSchema }),
  });
}

export function offsetListEnvelope<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    meta: ResponseMetaSchema.extend({ page: OffsetPageSchema }),
  });
}

// ── Query helpers ───────────────────────────────────────────────────────────

export const MAX_PAGE_SIZE = 100;

export const CursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
  cursor: z.string().min(1).optional(),
});
export type CursorQuery = z.infer<typeof CursorQuerySchema>;

export const OffsetQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
});
export type OffsetQuery = z.infer<typeof OffsetQuerySchema>;

/**
 * Builds a `sort` query param schema from an allow-list, e.g. "-createdAt,lastName".
 * Produces `[{ field: 'createdAt', direction: 'desc' }, ...]`.
 */
export function sortQuerySchema<const F extends string>(allowed: readonly [F, ...F[]]) {
  const fieldSet = new Set<string>(allowed);
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (!raw) return [] as { field: F; direction: 'asc' | 'desc' }[];
      const parts = raw
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const result: { field: F; direction: 'asc' | 'desc' }[] = [];
      for (const part of parts) {
        const desc = part.startsWith('-');
        const field = desc ? part.slice(1) : part;
        if (!fieldSet.has(field)) {
          ctx.addIssue({ code: 'custom', message: `Unsupported sort field: ${field}` });
          return z.NEVER;
        }
        result.push({ field: field as F, direction: desc ? 'desc' : 'asc' });
      }
      return result;
    });
}

// ── Health ──────────────────────────────────────────────────────────────────

export const HealthCheckSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  checks: z.record(z.string(), z.enum(['ok', 'down'])),
  version: z.string(),
  uptimeSeconds: z.number(),
});
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

// ── Idempotency ─────────────────────────────────────────────────────────────

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const VIEW_SESSION_HEADER = 'x-view-session';
export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
