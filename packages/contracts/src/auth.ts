import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema } from './common';
import { Role, UserStatus } from './enums';

/** Languages the product supports. packages/i18n must provide resources for each (tested there). */
export const LanguageSchema = z.enum(['en', 'nl']);
export type LanguageCode = z.infer<typeof LanguageSchema>;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'invalid_email' }).max(254));

/** New passwords: length-based policy (NIST 800-63B). No composition rules. */
export const NewPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, { message: 'password_too_short' })
  .max(PASSWORD_MAX_LENGTH, { message: 'password_too_long' })
  .refine((value) => value.trim().length >= PASSWORD_MIN_LENGTH, {
    message: 'password_too_short',
  });

const NameSchema = z.string().trim().min(1, { message: 'required' }).max(80);

/** E.164, e.g. +31612345678. */
export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, { message: 'invalid_phone' });

const OpaqueTokenSchema = z.string().min(20).max(512);

// ── Requests ────────────────────────────────────────────────────────────────

export const RegisterRequestSchema = z.object({
  email: EmailSchema,
  password: NewPasswordSchema,
  firstName: NameSchema,
  lastName: NameSchema,
  phone: PhoneSchema.optional(),
  preferredLanguage: LanguageSchema,
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  email: EmailSchema,
  // Existing passwords are never re-validated against the current policy, only length-capped.
  password: z.string().min(1, { message: 'required' }).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RefreshRequestSchema = z.object({ refreshToken: OpaqueTokenSchema });
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const ForgotPasswordRequestSchema = z.object({ email: EmailSchema });
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ResetPasswordRequestSchema = z.object({
  token: OpaqueTokenSchema,
  newPassword: NewPasswordSchema,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

export const VerifyEmailRequestSchema = z.object({ token: OpaqueTokenSchema });
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

// ── Responses ───────────────────────────────────────────────────────────────

export const SessionUserSchema = z.object({
  id: IdSchema,
  email: z.string(),
  role: Role,
  status: UserStatus,
  emailVerified: z.boolean(),
  firstName: z.string(),
  lastName: z.string(),
  preferredLanguage: LanguageSchema,
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: IsoDateTimeSchema,
  refreshToken: z.string(),
  refreshTokenExpiresAt: IsoDateTimeSchema,
});
export type AuthTokens = z.infer<typeof AuthTokensSchema>;

export const AuthSessionSchema = z.object({
  user: SessionUserSchema,
  tokens: AuthTokensSchema,
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

export const RegisterResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ACTIVE'), user: SessionUserSchema, tokens: AuthTokensSchema }),
  z.object({ status: z.literal('PENDING_APPROVAL') }),
]);
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

export const AcceptedSchema = z.object({ accepted: z.literal(true) });
