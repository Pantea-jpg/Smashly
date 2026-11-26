import { type OpenAPIRegistry, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import {
  ApiErrorSchema,
  cursorListEnvelope,
  dataEnvelope,
  offsetListEnvelope,
  ERROR_HTTP_STATUS,
  type ErrorCode,
  IDEMPOTENCY_HEADER,
} from '@tw/contracts';
import { type Request, type RequestHandler, type Response, Router } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import { type CsvValue, toCsv } from './csv';
import { parseRequest, sendCursorList, sendData, sendOffsetList } from './respond';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteSpec<
  B extends z.ZodType,
  Q extends z.ZodType,
  P extends z.ZodType,
  R extends z.ZodType | null,
> {
  method: Method;
  /** Express-style path relative to the router's mount point, e.g. "/users/:id". */
  path: string;
  summary: string;
  description?: string;
  tags: [string, ...string[]];
  /** Documentation of who may call it; enforcement is via `middleware`. */
  auth: 'public' | 'authenticated' | 'admin';
  middleware?: RequestHandler[];
  request?: { body?: B; query?: Q; params?: P };
  /** schema null → 204 No Content. */
  response: { status: number; schema: R };
  errors?: ErrorCode[];
  idempotencyKey?: 'required' | 'optional';
}

export interface HandlerInput<B, Q, P> {
  req: Request;
  res: Response;
  body: B;
  query: Q;
  params: P;
}

type Out<S extends z.ZodType | undefined> = S extends z.ZodType ? z.output<S> : undefined;

function toOpenApiPath(prefix: string, path: string): string {
  const full = path === '/' ? prefix : prefix + path;
  return full.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/**
 * Registers an Express route AND its OpenAPI operation from a single definition.
 *  - request parts are validated with the Zod schemas (typed handler input)
 *  - the handler's result is parsed with the response schema, which STRIPS unknown fields:
 *    an accidental extra property (e.g. a password hash) can never reach a client.
 */
export class ApiRouter {
  readonly router = Router();

  constructor(
    private readonly registry: OpenAPIRegistry,
    /** Full public path prefix of this router, e.g. "/api/v1/auth". */
    private readonly docsPrefix: string,
  ) {}

  route<
    B extends z.ZodType = z.ZodUndefined,
    Q extends z.ZodType = z.ZodUndefined,
    P extends z.ZodType = z.ZodUndefined,
    R extends z.ZodType | null = null,
  >(
    spec: RouteSpec<B, Q, P, R>,
    handler: (
      input: HandlerInput<Out<B>, Out<Q>, Out<P>>,
    ) => Promise<R extends z.ZodType ? z.input<R> : void>,
  ): void {
    this.document(spec);

    const run: RequestHandler = async (req, res) => {
      const { body, query, params } = parseRequest(req, spec.request ?? {});
      const result = await handler({
        req,
        res,
        body: body,
        query: query,
        params: params,
      });

      if (spec.response.schema === null) {
        res.status(spec.response.status).end();
        return;
      }
      const parsed = spec.response.schema.safeParse(result);
      if (!parsed.success) {
        // A handler returned data that does not match its contract: a server bug.
        throw new AppError('INTERNAL_ERROR', 'Response failed contract validation', undefined, {
          cause: parsed.error,
        });
      }
      sendData(req, res, parsed.data, spec.response.status);
    };

    this.router[spec.method](spec.path, ...(spec.middleware ?? []), run);
  }

  /**
   * A cursor-paginated feed: `{ data: Item[], meta: { requestId, page } }`.
   * Each item is parsed (and stripped) with the item schema.
   */
  cursorList<
    I extends z.ZodType,
    Q extends z.ZodType = z.ZodUndefined,
    P extends z.ZodType = z.ZodUndefined,
  >(
    spec: Omit<RouteSpec<z.ZodUndefined, Q, P, I>, 'response'> & { item: I },
    handler: (input: HandlerInput<undefined, Out<Q>, Out<P>>) => Promise<{
      items: z.input<I>[];
      page: { nextCursor: string | null; hasMore: boolean };
    }>,
  ): void {
    this.list(spec, handler, 'cursorList', (req, res, items, page) =>
      sendCursorList(req, res, items, page),
    );
  }

  /**
   * A page of an admin table: `{ data: Item[], meta: { requestId, page: { page, pageSize, total } } }`.
   */
  offsetList<
    I extends z.ZodType,
    Q extends z.ZodType = z.ZodUndefined,
    P extends z.ZodType = z.ZodUndefined,
  >(
    spec: Omit<RouteSpec<z.ZodUndefined, Q, P, I>, 'response'> & { item: I },
    handler: (input: HandlerInput<undefined, Out<Q>, Out<P>>) => Promise<{
      items: z.input<I>[];
      page: { page: number; pageSize: number; total: number };
    }>,
  ): void {
    this.list(spec, handler, 'offsetList', (req, res, items, page) =>
      sendOffsetList(req, res, items, page),
    );
  }

  /** A CSV download (attachment). Text cells are protected against formula injection. */
  csv<Q extends z.ZodType = z.ZodUndefined>(
    spec: Omit<RouteSpec<z.ZodUndefined, Q, z.ZodUndefined, null>, 'response'>,
    handler: (
      input: HandlerInput<undefined, Out<Q>, undefined>,
    ) => Promise<{ filename: string; header: string[]; rows: CsvValue[][] }>,
  ): void {
    this.document({ ...spec, response: { status: 200, schema: null } }, 'csv');
    const run: RequestHandler = async (req, res) => {
      const { query } = parseRequest(req, spec.request ?? {});
      const file = await handler({
        req,
        res,
        body: undefined,
        query: query,
        params: undefined,
      });
      res
        .status(200)
        .type('text/csv; charset=utf-8')
        .set(
          'content-disposition',
          `attachment; filename="${file.filename.replace(/[^\w.-]/g, '_')}"`,
        )
        .set('cache-control', 'no-store')
        .send(toCsv(file.header, file.rows));
    };
    this.router[spec.method](spec.path, ...(spec.middleware ?? []), run);
  }

  private list<I extends z.ZodType, Q extends z.ZodType, P extends z.ZodType, Page>(
    spec: Omit<RouteSpec<z.ZodUndefined, Q, P, I>, 'response'> & { item: I },
    handler: (
      input: HandlerInput<undefined, Out<Q>, Out<P>>,
    ) => Promise<{ items: z.input<I>[]; page: Page }>,
    kind: 'cursorList' | 'offsetList',
    send: (req: Request, res: Response, items: z.output<I>[], page: Page) => void,
  ): void {
    this.document({ ...spec, response: { status: 200, schema: spec.item } }, kind);

    const run: RequestHandler = async (req, res) => {
      const { query, params } = parseRequest(req, spec.request ?? {});
      const result = await handler({
        req,
        res,
        body: undefined,
        query: query,
        params: params,
      });
      const items = z.array(spec.item).safeParse(result.items);
      if (!items.success) {
        throw new AppError('INTERNAL_ERROR', 'Response failed contract validation', undefined, {
          cause: items.error,
        });
      }
      send(req, res, items.data, result.page);
    };

    this.router[spec.method](spec.path, ...(spec.middleware ?? []), run);
  }

  private document(
    spec: RouteSpec<z.ZodType, z.ZodType, z.ZodType, z.ZodType | null>,
    kind: 'data' | 'cursorList' | 'offsetList' | 'csv' = 'data',
  ): void {
    const errorCodes = new Set<ErrorCode>(['VALIDATION_ERROR', 'RATE_LIMITED', 'INTERNAL_ERROR']);
    if (spec.auth !== 'public') {
      errorCodes.add('UNAUTHENTICATED');
      errorCodes.add('TOKEN_EXPIRED');
      errorCodes.add('ACCOUNT_INACTIVE');
    }
    if (spec.auth === 'admin') errorCodes.add('FORBIDDEN');
    spec.errors?.forEach((code) => errorCodes.add(code));

    const byStatus = new Map<number, ErrorCode[]>();
    for (const code of errorCodes) {
      const status = ERROR_HTTP_STATUS[code];
      byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
    }

    const responses: RouteConfig['responses'] = {};
    responses[spec.response.status] =
      kind === 'csv'
        ? {
            description: 'CSV file (UTF-8 with BOM)',
            content: { 'text/csv': { schema: z.string() } },
          }
        : spec.response.schema === null
          ? { description: 'No content' }
          : {
              description: 'Success',
              content: {
                'application/json': {
                  schema:
                    kind === 'cursorList'
                      ? cursorListEnvelope(spec.response.schema)
                      : kind === 'offsetList'
                        ? offsetListEnvelope(spec.response.schema)
                        : dataEnvelope(spec.response.schema),
                },
              },
            };
    for (const [status, codes] of byStatus) {
      responses[status] = {
        description: `Error codes: ${codes.join(', ')}`,
        content: { 'application/json': { schema: ApiErrorSchema } },
      };
    }

    const headers =
      spec.idempotencyKey === undefined
        ? undefined
        : z.object({
            [IDEMPOTENCY_HEADER]:
              spec.idempotencyKey === 'required' ? z.string() : z.string().optional(),
          });

    const request: RouteConfig['request'] = {};
    if (spec.request?.body) {
      request.body = { content: { 'application/json': { schema: spec.request.body } } };
    }
    if (spec.request?.query)
      request.query = spec.request.query as RouteConfig['request'] extends { query?: infer T }
        ? T
        : never;
    if (spec.request?.params)
      request.params = spec.request.params as RouteConfig['request'] extends { params?: infer T }
        ? T
        : never;
    if (headers) request.headers = headers;

    this.registry.registerPath({
      method: spec.method,
      path: toOpenApiPath(this.docsPrefix, spec.path),
      summary: spec.summary,
      ...(spec.description ? { description: spec.description } : {}),
      tags: spec.tags,
      ...(spec.auth === 'public' ? {} : { security: [{ bearerAuth: [] }] }),
      request,
      responses,
    });
  }
}
