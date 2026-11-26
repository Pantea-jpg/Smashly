# syntax=docker/dockerfile:1
# Build from the repository root:  docker build -f apps/api/Dockerfile -t tw-api .
#
# One image runs everything (Render, Phase 10):
#   API (default CMD)  ->  node dist/main.js
#   worker             ->  node dist/worker.js           (Render: dockerCommand)
#   migrations         ->  node_modules/.bin/prisma migrate deploy   (Render: preDeployCommand)
# The `migrate` target is kept for running migrations by hand with plain Docker.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @tw/api...
RUN pnpm --filter @tw/api build
# Production-only node_modules for the API (workspace packages are already bundled into dist).
# Includes the Prisma CLI, which the release step uses to apply migrations.
RUN pnpm --filter @tw/api deploy --prod --legacy --ignore-scripts /out

FROM build AS migrate
WORKDIR /repo/apps/api
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
# The version reported by /health and Sentry comes from RENDER_GIT_COMMIT on Render, or from
# an explicit APP_VERSION environment variable elsewhere (see config/env.ts).
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
# Schema, migrations and config for `prisma migrate deploy` (the pre-deploy release step).
COPY --from=build --chown=node:node /repo/apps/api/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=build --chown=node:node /repo/apps/api/prisma/migrations ./prisma/migrations
COPY --from=build --chown=node:node /repo/apps/api/prisma.config.ts ./prisma.config.ts
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health/live || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]
