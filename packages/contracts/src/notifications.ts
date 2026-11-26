import { z } from 'zod';
import { CursorQuerySchema, IdSchema, IsoDateTimeSchema } from './common';
import { DevicePlatform, NotificationCategory, NotificationType, PushProvider } from './enums';

/** Rendered by the app from `notifications:<type>` with `params` (language-neutral). */
export const NotificationSchema = z.object({
  id: IdSchema,
  type: NotificationType,
  category: NotificationCategory,
  params: z.record(z.string(), z.unknown()),
  readAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationQuerySchema = CursorQuerySchema.extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const MarkNotificationsReadRequestSchema = z
  .object({
    ids: z.array(IdSchema).min(1).max(100).optional(),
    all: z.literal(true).optional(),
  })
  .refine((v) => (v.ids === undefined) !== (v.all === undefined), { message: 'ids_or_all' });

export const UnreadCountSchema = z.object({ unread: z.number().int() });

// ── Devices (push registration) ─────────────────────────────────────────────

/** A native APNs device token is 32 bytes, sent as 64 hex characters (longer is allowed). */
export const ApnsDeviceTokenSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64,200}$/, { message: 'invalid_device_token' })
  .transform((v) => v.toLowerCase());

export const RegisterDeviceRequestSchema = z.object({
  token: ApnsDeviceTokenSchema,
  platform: z.literal('IOS'),
  provider: z.literal('APNS').default('APNS'),
  appVersion: z.string().trim().min(1).max(32).optional(),
});
export type RegisterDeviceRequest = z.input<typeof RegisterDeviceRequestSchema>;

export const DeviceSchema = z.object({
  id: IdSchema,
  platform: DevicePlatform,
  provider: PushProvider,
  appVersion: z.string().nullable(),
  lastSeenAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
});
export type Device = z.infer<typeof DeviceSchema>;
