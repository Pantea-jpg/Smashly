import { ApiErrorSchema, type ErrorCode } from '@tw/contracts';
import type { z } from 'zod';

/**
 * Base URL of the API. Set EXPO_PUBLIC_API_URL per build profile.
 * Must stay a literal `process.env.EXPO_PUBLIC_…` member access: Expo inlines it at build
 * time only in that exact form (an alias or bracket access would ship `undefined`).
 */
export const API_URL: string = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
export const API_PREFIX = '/api/v1';

export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR';

/** Every failed API call surfaces as this error; the UI translates `code`, never `message`. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly code: ClientErrorCode,
    readonly status: number,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export function isApiError(error: unknown, code?: ClientErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

export interface HttpRequest<S extends z.ZodType | undefined> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  accessToken?: string | null;
  language?: string;
  /** Validates `data` of the response envelope. Omit for 204 responses. */
  schema?: S;
  /** "data" (default) validates `data` of the envelope; "full" validates the whole body (lists with meta.page). */
  envelope?: 'data' | 'full';
  headers?: Record<string, string>;
}

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * One HTTP call: JSON in, `{ data }` envelope out, normalised errors.
 * No auth logic here (see SessionController for token handling and refresh).
 */
export async function httpRequest<S extends z.ZodType | undefined = undefined>(
  request: HttpRequest<S>,
  baseUrl: string = API_URL,
): Promise<S extends z.ZodType ? z.output<S> : undefined> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(request.accessToken ? { authorization: `Bearer ${request.accessToken}` } : {}),
    ...(request.language ? { 'accept-language': request.language } : {}),
    ...request.headers,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${API_PREFIX}${request.path}`, {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', 0, 'Network request failed');
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 204) {
    return undefined as S extends z.ZodType ? z.output<S> : undefined;
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ApiError('INTERNAL_ERROR', response.status, 'Invalid JSON response');
  }

  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(json);
    if (parsed.success) {
      const { code, message, details, requestId } = parsed.data.error;
      throw new ApiError(code, response.status, message, details, requestId);
    }
    throw new ApiError('INTERNAL_ERROR', response.status, `HTTP ${response.status}`);
  }

  if (!request.schema) return undefined as S extends z.ZodType ? z.output<S> : undefined;
  const data = request.envelope === 'full' ? json : (json as { data?: unknown } | null)?.data;
  const parsed = request.schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError('INTERNAL_ERROR', response.status, 'Unexpected response shape');
  }
  return parsed.data as S extends z.ZodType ? z.output<S> : undefined;
}
