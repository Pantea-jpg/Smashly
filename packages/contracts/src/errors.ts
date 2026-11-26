import { z } from 'zod';

/**
 * Language-neutral API error codes. The app translates them via the `errors`
 * i18n namespace (`errors:<CODE>`); the server's English `message` is for logs/devs.
 */
export const ERROR_HTTP_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  INVALID_TOKEN: 400,
  ACCOUNT_INACTIVE: 403,
  ACCOUNT_PENDING_APPROVAL: 403,
  EMAIL_NOT_VERIFIED: 403,
  FORBIDDEN: 403,
  VIEW_AS_READ_ONLY: 403,
  VIEW_SESSION_INVALID: 403,
  CANNOT_MODIFY_OWN_ACCOUNT: 409,
  NOT_FOUND: 404,
  CONFLICT: 409,
  EMAIL_ALREADY_REGISTERED: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  TRAINING_FULL: 409,
  TRAINING_CANCELLED: 409,
  RESERVATION_DEADLINE_PASSED: 409,
  ATTENDANCE_FINALIZED: 409,
  ATTENDANCE_HAS_PENDING: 409,
  TRAINING_NOT_STARTED: 409,
  RESERVATION_BLOCKED_BY_DEBT: 409,
  ALREADY_REVERSED: 409,
  NOT_REVERSIBLE: 409,
  INSUFFICIENT_BALANCE: 409,
  ACCOUNT_HAS_BALANCE_OR_DEBT: 409,
  PAYLOAD_TOO_LARGE: 413,
  AMOUNT_OUT_OF_RANGE: 422,
  BALANCE_LIMIT_EXCEEDED: 422,
  /** The new password appears in a known data breach (Have I Been Pwned, ASVS 2.1.7). */
  PASSWORD_BREACHED: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  PAYMENT_PROVIDER_ERROR: 502,
  PAYMENTS_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;

export const ERROR_CODES = Object.keys(ERROR_HTTP_STATUS) as [ErrorCode, ...ErrorCode[]];

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
