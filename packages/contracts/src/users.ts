import { z } from 'zod';
import { LanguageSchema, NewPasswordSchema, PhoneSchema, SessionUserSchema } from './auth';
import {
  IdSchema,
  IsoDateTimeSchema,
  MoneySchema,
  OffsetQuerySchema,
  sortQuerySchema,
} from './common';
import { NotificationCategory, Role, UserStatus } from './enums';

const NameSchema = z.string().trim().min(1, { message: 'required' }).max(80);

// ── Profile (self) ──────────────────────────────────────────────────────────

export const ProfileSchema = z.object({
  id: IdSchema,
  email: z.string(),
  role: Role,
  status: UserStatus,
  emailVerified: z.boolean(),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  preferredLanguage: LanguageSchema,
  createdAt: IsoDateTimeSchema,
});
export type Profile = z.infer<typeof ProfileSchema>;

export const UpdateProfileRequestSchema = z
  .object({
    firstName: NameSchema.optional(),
    lastName: NameSchema.optional(),
    /** null clears the phone number. */
    phone: PhoneSchema.nullable().optional(),
    preferredLanguage: LanguageSchema.optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'nothing_to_update',
  });
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1, { message: 'required' }).max(128),
  newPassword: NewPasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

export const NotificationPreferenceSchema = z.object({
  category: NotificationCategory,
  pushEnabled: z.boolean(),
});
export const NotificationPreferencesSchema = z.array(NotificationPreferenceSchema);
export type NotificationPreference = z.infer<typeof NotificationPreferenceSchema>;

export const UpdateNotificationPreferencesRequestSchema = z
  .array(NotificationPreferenceSchema)
  .min(1)
  .max(10)
  .refine((items) => new Set(items.map((i) => i.category)).size === items.length, {
    message: 'duplicate_category',
  });

export const AVATAR_CONTENT_TYPES = ['image/jpeg', 'image/png'] as const;
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export const AvatarUploadUrlRequestSchema = z.object({
  contentType: z.enum(AVATAR_CONTENT_TYPES),
  sizeBytes: z.number().int().positive().max(AVATAR_MAX_BYTES),
});
export type AvatarUploadUrlRequest = z.infer<typeof AvatarUploadUrlRequestSchema>;

export const AvatarUploadUrlSchema = z.object({
  uploadUrl: z.string(),
  objectKey: z.string(),
  /** Headers the client must send with the PUT (signed). */
  headers: z.record(z.string(), z.string()),
  expiresAt: IsoDateTimeSchema,
});
export type AvatarUploadUrl = z.infer<typeof AvatarUploadUrlSchema>;

export const ConfirmAvatarRequestSchema = z.object({
  objectKey: z.string().min(1).max(256),
});

export const DeleteAccountRequestSchema = z.object({
  password: z.string().min(1, { message: 'required' }).max(128),
});
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>;

// ── Admin: users ────────────────────────────────────────────────────────────

export const USER_SORT_FIELDS = ['createdAt', 'lastName', 'email', 'lastLoginAt'] as const;

export const AdminUserListQuerySchema = OffsetQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  status: UserStatus.optional(),
  role: Role.default('USER'),
  hasDebt: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  sort: sortQuerySchema(USER_SORT_FIELDS),
});
export type AdminUserListQuery = z.infer<typeof AdminUserListQuerySchema>;

export const AdminUserListItemSchema = z.object({
  id: IdSchema,
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  avatarUrl: z.string().nullable(),
  role: Role,
  status: UserStatus,
  emailVerified: z.boolean(),
  balance: MoneySchema.nullable(),
  debt: MoneySchema.nullable(),
  createdAt: IsoDateTimeSchema,
  lastLoginAt: IsoDateTimeSchema.nullable(),
});
export type AdminUserListItem = z.infer<typeof AdminUserListItemSchema>;

export const AdminUserDetailSchema = AdminUserListItemSchema.extend({
  phone: z.string().nullable(),
  preferredLanguage: LanguageSchema,
  deletedAt: IsoDateTimeSchema.nullable(),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;

export const UpdateUserStatusRequestSchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE']),
  reason: z.string().trim().min(3, { message: 'required' }).max(500),
});
export type UpdateUserStatusRequest = z.infer<typeof UpdateUserStatusRequestSchema>;

export const UserIdParamsSchema = z.object({ id: IdSchema });

// ── Admin: View as User ─────────────────────────────────────────────────────

export const CreateViewSessionRequestSchema = z.object({ userId: IdSchema });

export const ViewSessionSchema = z.object({
  id: IdSchema,
  expiresAt: IsoDateTimeSchema,
  subject: SessionUserSchema,
});
export type ViewSession = z.infer<typeof ViewSessionSchema>;

// ── Admin: settings ─────────────────────────────────────────────────────────

const SettingMinorSchema = z.number().int().nonnegative().max(1_000_000_00);

/** "HH:MM" on a 24-hour clock. */
export const ClockTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'invalid_time' });
export const QuietHoursSchema = z
  .object({ start: ClockTimeSchema, end: ClockTimeSchema })
  .refine((v) => v.start !== v.end, { message: 'empty_window', path: ['end'] });
export type QuietHours = z.infer<typeof QuietHoursSchema>;

export const AdminSettingsSchema = z.object({
  registrationRequiresApproval: z.boolean(),
  topUpMinMinor: SettingMinorSchema,
  topUpMaxMinor: SettingMinorSchema,
  maxBalanceMinor: SettingMinorSchema,
  topUpPresetsMinor: z.array(SettingMinorSchema).max(8),
  lowBalanceThresholdMinor: SettingMinorSchema,
  /** D10: refuse new reservations while debt is above this amount; null = never block. */
  reservationDebtBlockMinor: SettingMinorSchema.nullable(),
  /** D22: no pushes in this local-time window (except payment confirmations); null = off. */
  quietHours: QuietHoursSchema.nullable(),
});
export type AdminSettings = z.infer<typeof AdminSettingsSchema>;

export const UpdateAdminSettingsRequestSchema = AdminSettingsSchema.partial()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'nothing_to_update',
  })
  .refine(
    (v) =>
      v.topUpMinMinor === undefined ||
      v.topUpMaxMinor === undefined ||
      v.topUpMinMinor <= v.topUpMaxMinor,
    { message: 'min_exceeds_max', path: ['topUpMinMinor'] },
  );
export type UpdateAdminSettingsRequest = z.infer<typeof UpdateAdminSettingsRequestSchema>;
