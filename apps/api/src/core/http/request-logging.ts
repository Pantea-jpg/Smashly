import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pinoHttp } from 'pino-http';
import type { Logger } from '../logger/logger';

const REQUEST_ID_HEADER = 'x-request-id';
const VALID_INCOMING_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** The id assigned by `requestLogging` (always a string; see genReqId below). */
export function getRequestId(req: IncomingMessage): string {
  return typeof req.id === 'string' ? req.id : 'unknown';
}

/**
 * Assigns every request an id (reusing a well-formed upstream X-Request-Id),
 * echoes it in the response and attaches a child logger as `req.log`.
 */
export function requestLogging(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      const id =
        typeof incoming === 'string' && VALID_INCOMING_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Keep access logs lean; headers are redacted by the base logger anyway.
    serializers: {
      req: (req: { id: unknown; method: unknown; url: unknown }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
      res: (res: { statusCode: unknown }) => ({ statusCode: res.statusCode }),
    },
    autoLogging: {
      ignore: (req) => req.url === '/health/live',
    },
  });
}
