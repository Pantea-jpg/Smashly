import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import type express from 'express';
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

export function createOpenApiRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Short-lived access token from /auth/login or /auth/refresh.',
  });
  return registry;
}

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

export function generateOpenApiDocument(
  registry: OpenAPIRegistry,
  version: string,
): OpenApiDocument {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Training Wallet API',
      version,
      description:
        'REST API for the sports training and wallet platform. Money is always integer minor units with an ISO 4217 currency. Errors use a language-neutral `code`.',
    },
    servers: [{ url: '/' }],
  });
}

/** Swagger UI + raw JSON. Mounted only when ENABLE_API_DOCS (never in production). */
export function docsRouter(getDocument: () => OpenApiDocument): Router {
  const router = Router();
  let cached: OpenApiDocument | undefined;
  const document = () => (cached ??= getDocument());

  router.get('/openapi.json', (_req, res) => {
    res.json(document());
  });
  router.use(
    '/',
    swaggerUi.serve,
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      swaggerUi.setup(document(), { customSiteTitle: 'Training Wallet API' })(req, res, next);
    },
  );
  return router;
}
