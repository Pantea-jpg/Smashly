-- The append-only/no-delete triggers raised SQLSTATE 23001 (restrict_violation), which Prisma
-- reports as "Foreign key constraint violated" and drops our message. Use the default
-- SQLSTATE P0001 (raise_exception) so the real reason reaches logs and error reports.
-- Behaviour is unchanged: the operations are still rejected.

CREATE OR REPLACE FUNCTION "forbid_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME;
END
$$;

CREATE OR REPLACE FUNCTION "forbid_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DELETE on % is not allowed: financial records are retained', TG_TABLE_NAME;
END
$$;
