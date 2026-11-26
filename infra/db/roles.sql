-- Provision once per environment (staging/production) as a superuser, BEFORE the first
-- `prisma migrate deploy`. Passwords come from the secret manager, never from this file.
--
--   app_migrator : owns the schema, runs migrations (DATABASE_URL of the migrate job)
--   app_runtime  : used by api + worker; cannot UPDATE/DELETE ledger or audit rows
--
-- Local development uses the single docker-compose user, which is fine for dev only.

CREATE ROLE app_migrator LOGIN PASSWORD :'migrator_password';
CREATE ROLE app_runtime LOGIN PASSWORD :'runtime_password';

GRANT CONNECT ON DATABASE training_wallet TO app_migrator, app_runtime;
GRANT USAGE, CREATE ON SCHEMA public TO app_migrator;
GRANT USAGE ON SCHEMA public TO app_runtime;

-- Tables created by future migrations are readable/writable by the runtime role by default;
-- the init migration then revokes UPDATE/DELETE on append-only and financial tables.
-- Later migrations that add append-only tables must add their own REVOKE statements.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
