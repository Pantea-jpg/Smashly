import { z } from 'zod';
import { CursorQuerySchema, IdSchema, IsoDateTimeSchema } from './common';
import { Role } from './enums';

export const AuditLogQuerySchema = CursorQuerySchema.extend({
  actorId: IdSchema.optional(),
  entityType: z.string().min(1).max(64).optional(),
  entityId: z.string().min(1).max(64).optional(),
  action: z.string().min(1).max(64).optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
});
export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;

export const AuditLogEntrySchema = z.object({
  id: IdSchema,
  actorId: IdSchema.nullable(),
  actorRole: Role.nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  viewSessionId: IdSchema.nullable(),
  requestId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;
