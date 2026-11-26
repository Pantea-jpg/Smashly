# ADR 0001: Stack and pinned versions (Phase 2)

- **Status:** Accepted
- **Date:** 2026-11-24
- **Context:** Phase 1 architecture was approved with the default business decisions. Phase 2 sets up the monorepo. The versions below were checked against the npm registry on 2026-11-24. They are pinned exactly (`save-exact=true`), and the lockfile is committed.

## Decisions

| Area | Pinned | Notes |
|---|---|---|
| Node.js | 24 LTS (`.nvmrc`, `engines`) | |
| Package manager | pnpm 10.34.9 via Corepack | pnpm 12 is the latest major, but 10 is the most proven with Expo/Metro. `node-linker=hoisted` follows Expo's monorepo guidance for React Native native-module resolution. |
| TypeScript | **6.0.3** | TS 7.0 (native compiler) is out, but `typescript-eslint` 8.74 supports `<6.1`. Revisit when typed linting supports TS 7. TS 6 defaults `types` to `[]`, so each tsconfig lists its globals explicitly. |
| Module resolution | `Bundler` everywhere | Shared packages export TypeScript source. The API is bundled with esbuild for production and run with tsx in development, so extensionless imports work in API, app and tests alike. |
| API | Express 5.3.0, Zod 4.6.7, helmet 8.3.0, cors 2.8.6, pino 10.4 / pino-http 11 | |
| ORM | **Prisma 7.10.1** + `@prisma/adapter-pg` | Prisma 8 is still a release candidate. Prisma 7: the `prisma-client` generator writes TS into `src/generated/prisma` (gitignored, created on `postinstall`), the connection URL lives in `prisma.config.ts`, and the client uses the node-postgres driver adapter. |
| API bundling | esbuild 0.28.2 | Workspace packages and the generated client are bundled in. npm dependencies stay external. |
| Tests (API/packages) | Vitest 5.1.1, Supertest 7.3.2 | Testcontainers is added in Phase 3 for Postgres integration tests. |
| Mobile | **Expo SDK 58** (React Native 0.88.1, React 19.3) | Native module versions come from Expo's `bundledNativeModules.json`, not from guesses. |
| Navigation | React Navigation 7.5 (native-stack 7.21, bottom-tabs 7.22) | The spec requires React Navigation, so Expo Router is not used. |
| State | TanStack Query 5.108, Zustand 5.1 (+ AsyncStorage 2.2 persistence) | |
| i18n | i18next 27.2, react-i18next 18.0, expo-localization 58 | Translation keys are type-checked via `CustomTypeOptions`. |
| Mobile tests | Jest 30.5 + jest-expo 58, React Native Testing Library 14.1 (+ `test-renderer`) | |
| Lint/format | ESLint 10.15 (flat config), typescript-eslint 8.74 (type-aware), react-hooks 7.1, eslint-plugin-i18next 6.1, Prettier 3.10 | `i18next/no-literal-string` blocks hard-coded UI text in mobile screens. |
| Local services | Postgres 17, Valkey 8 (Redis-compatible, BSD-licensed), Mailpit | `infra/docker-compose.yml` |

## Consequences
- Upgrading Expo means running `npx expo install --fix` for native modules. Other packages are bumped deliberately in their own pull requests.
- Moving to TS 7 and pnpm 11/12 are tracked follow-ups, not blockers.
