-- NOTE: the trigger functions defined below were superseded by migration
-- 20261124130000_append_only_error_code (same behaviour, different SQLSTATE).

-- ============================================================================
-- Hand-written constraints (not expressible in schema.prisma).
-- Source of truth for docs/03-database.md §6. Appended to the init migration.
-- ============================================================================

-- ── Wallets: cached projections can never go negative ──────────────────────
ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_balance_nonneg" CHECK ("balance_minor" >= 0),
  ADD CONSTRAINT "wallets_debt_nonneg" CHECK ("debt_minor" >= 0),
  ADD CONSTRAINT "wallets_sequence_nonneg" CHECK ("sequence" >= 0),
  ADD CONSTRAINT "wallets_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');

-- ── Ledger rows are self-consistent ────────────────────────────────────────
ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wt_amount_positive" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "wt_sequence_positive" CHECK ("sequence" > 0),
  ADD CONSTRAINT "wt_balance_chain" CHECK ("balance_after_minor" = "balance_before_minor" + "wallet_delta_minor"),
  ADD CONSTRAINT "wt_debt_chain" CHECK ("debt_after_minor" = "debt_before_minor" + "debt_delta_minor"),
  ADD CONSTRAINT "wt_nonneg" CHECK (
    "balance_before_minor" >= 0 AND "balance_after_minor" >= 0
    AND "debt_before_minor" >= 0 AND "debt_after_minor" >= 0
  ),
  ADD CONSTRAINT "wt_reason_required" CHECK (
    "type" NOT IN ('ADJUSTMENT', 'REVERSAL', 'REFUND') OR ("reason" IS NOT NULL AND length(trim("reason")) > 0)
  ),
  ADD CONSTRAINT "wt_admin_for_cash" CHECK ("type" <> 'CASH_TOP_UP' OR "created_by_admin_id" IS NOT NULL),
  ADD CONSTRAINT "wt_payment_for_online" CHECK ("type" <> 'ONLINE_TOP_UP' OR "payment_id" IS NOT NULL),
  ADD CONSTRAINT "wt_reversal_link" CHECK (("type" = 'REVERSAL') = ("reverses_transaction_id" IS NOT NULL)),
  ADD CONSTRAINT "wt_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');

-- ── Charges, debts, settlements ────────────────────────────────────────────
ALTER TABLE "training_charges"
  ADD CONSTRAINT "charge_amounts_nonneg" CHECK (
    "unit_price_minor" >= 0 AND "paid_from_wallet_minor" >= 0 AND "shortfall_minor" >= 0
  ),
  ADD CONSTRAINT "charge_split" CHECK ("paid_from_wallet_minor" + "shortfall_minor" = "unit_price_minor");

ALTER TABLE "debts"
  ADD CONSTRAINT "debts_original_positive" CHECK ("original_amount_minor" > 0),
  ADD CONSTRAINT "debts_outstanding_range" CHECK (
    "outstanding_amount_minor" >= 0 AND "outstanding_amount_minor" <= "original_amount_minor"
  ),
  ADD CONSTRAINT "debts_status_consistent" CHECK (
    ("status" = 'OPEN' AND "outstanding_amount_minor" > 0)
    OR ("status" = 'SETTLED' AND "outstanding_amount_minor" = 0)
    OR ("status" = 'CANCELLED')
  );

ALTER TABLE "debt_settlements"
  ADD CONSTRAINT "debt_settlements_positive" CHECK ("amount_minor" > 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "payments_refund_range" CHECK (
    "refunded_amount_minor" >= 0 AND "refunded_amount_minor" <= "amount_minor"
  );

-- ── Trainings and pricing ──────────────────────────────────────────────────
ALTER TABLE "trainings"
  ADD CONSTRAINT "training_times" CHECK ("ends_at" > "starts_at"),
  ADD CONSTRAINT "training_deadline" CHECK ("reservation_deadline" <= "starts_at"),
  ADD CONSTRAINT "training_price" CHECK ("default_price_minor" >= 0),
  ADD CONSTRAINT "training_capacity" CHECK ("capacity" IS NULL OR "capacity" > 0);

ALTER TABLE "training_series"
  ADD CONSTRAINT "series_price" CHECK ("default_price_minor" >= 0),
  ADD CONSTRAINT "series_duration" CHECK ("duration_minutes" > 0),
  ADD CONSTRAINT "series_deadline_offset" CHECK ("deadline_offset_min" >= 0),
  ADD CONSTRAINT "series_capacity" CHECK ("capacity" IS NULL OR "capacity" > 0);

ALTER TABLE "training_price_overrides"
  ADD CONSTRAINT "override_price" CHECK ("price_minor" >= 0);

ALTER TABLE "user_standing_prices"
  ADD CONSTRAINT "standing_price" CHECK ("price_minor" >= 0);

-- ── Identity ───────────────────────────────────────────────────────────────
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email")),
  ADD CONSTRAINT "users_token_version_nonneg" CHECK ("token_version" >= 0);

-- ── Append-only tables: UPDATE and DELETE are rejected at the database level ──
CREATE FUNCTION "forbid_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER "wallet_transactions_append_only"
  BEFORE UPDATE OR DELETE ON "wallet_transactions"
  FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();

CREATE TRIGGER "debt_settlements_append_only"
  BEFORE UPDATE OR DELETE ON "debt_settlements"
  FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();

CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "forbid_mutation"();

-- Financial lifecycle rows may change status but are never deleted.
CREATE FUNCTION "forbid_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DELETE on % is not allowed: financial records are retained', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER "training_charges_no_delete" BEFORE DELETE ON "training_charges"
  FOR EACH ROW EXECUTE FUNCTION "forbid_delete"();
CREATE TRIGGER "debts_no_delete" BEFORE DELETE ON "debts"
  FOR EACH ROW EXECUTE FUNCTION "forbid_delete"();
CREATE TRIGGER "payments_no_delete" BEFORE DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "forbid_delete"();
CREATE TRIGGER "stripe_events_no_delete" BEFORE DELETE ON "stripe_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_delete"();
CREATE TRIGGER "wallets_no_delete" BEFORE DELETE ON "wallets"
  FOR EACH ROW EXECUTE FUNCTION "forbid_delete"();

-- ── Least-privilege runtime role (only if provisioned; see infra/db/roles.sql) ──
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT USAGE ON SCHEMA public TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
    REVOKE UPDATE, DELETE ON "wallet_transactions", "debt_settlements", "audit_logs" FROM app_runtime;
    REVOKE DELETE ON "training_charges", "debts", "payments", "stripe_events", "wallets" FROM app_runtime;
  END IF;
END
$$;
