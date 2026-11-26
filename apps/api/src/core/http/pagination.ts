import { z } from 'zod';
import { AppError } from '../errors/app-error';

const UuidSchema = z.uuid();

/** Opaque cursor for id-ordered feeds (UUIDv7 ids sort by creation time). */
export function encodeIdCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeIdCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const parsed = UuidSchema.safeParse(decoded);
  if (!parsed.success) throw AppError.validation({ cursor: 'invalid' }, 'Invalid cursor');
  return parsed.data;
}
