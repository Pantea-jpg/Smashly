import { ERROR_HTTP_STATUS, type ErrorCode } from '@tw/contracts';

/**
 * The only error type services should throw for expected failures.
 * Anything else reaching the error handler is treated as a bug (500, logged, details hidden).
 */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.status = ERROR_HTTP_STATUS[code];
  }

  static validation(details: unknown, message = 'Request validation failed'): AppError {
    return new AppError('VALIDATION_ERROR', message, details);
  }

  static notFound(what = 'Resource'): AppError {
    return new AppError('NOT_FOUND', `${what} not found`);
  }

  static forbidden(message = 'Forbidden'): AppError {
    return new AppError('FORBIDDEN', message);
  }

  static unauthenticated(message = 'Authentication required'): AppError {
    return new AppError('UNAUTHENTICATED', message);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
