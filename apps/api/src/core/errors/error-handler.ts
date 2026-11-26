import type { ApiError, ErrorCode } from '@tw/contracts';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';
import { getRequestId } from '../http/request-logging';
import { alerts } from '../observability/alerts';
import { AppError, isAppError } from './app-error';

interface BodyParserError {
  type: string;
  status?: number;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return (
    typeof error === 'object' && error !== null && 'type' in error && typeof error.type === 'string'
  );
}

function toAppError(error: unknown): AppError | null {
  if (isAppError(error)) return error;
  if (error instanceof z.ZodError) {
    return AppError.validation(z.flattenError(error));
  }
  if (isBodyParserError(error)) {
    if (error.type === 'entity.parse.failed') {
      return AppError.validation(undefined, 'Malformed JSON body');
    }
    if (error.type === 'entity.too.large') {
      return new AppError('PAYLOAD_TOO_LARGE', 'Request body too large');
    }
    if (error.type === 'encoding.unsupported' || error.type === 'charset.unsupported') {
      return AppError.validation(undefined, 'Unsupported body encoding');
    }
  }
  return null;
}

/** Final Express error handler: consistent envelope, no internals leaked. */
export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  const requestId = getRequestId(req);
  const known = toAppError(error);

  let code: ErrorCode;
  let status: number;
  let message: string;
  let details: unknown;

  if (known) {
    ({ code, status, message, details } = known);
    // Expected failures: no stack trace, and no details (they may echo user input / PII).
    req.log.warn({ code, status }, message);
  } else {
    code = 'INTERNAL_ERROR';
    status = 500;
    message = 'Internal server error';
    alerts.exception(req.log, error, {
      requestId,
      method: req.method,
      route: req.baseUrl + req.path,
    });
  }

  if (res.headersSent) {
    // Too late to send an envelope; let Node close the connection.
    return;
  }

  const body: ApiError = {
    error: { code, message, requestId, ...(details === undefined ? {} : { details }) },
  };
  res.status(status).json(body);
};

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError('NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};
