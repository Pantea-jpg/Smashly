-- Phase 9 performance review (docs/performance.md):
--   * a (created_at DESC, sequence DESC) index for the admin ledger list, dashboard activity and
--     period reports, which read the whole ledger to show one page;
--   * an index for every foreign key that had none (cheap joins and cascading deletes);
--   * created_at for the admin payments list.
-- Plain CREATE INDEX (inside the migration transaction) is fine at launch volumes. On a large
-- production database, build such indexes CONCURRENTLY by hand first (see docs/performance.md).
-- CreateIndex
CREATE INDEX "wallet_transactions_created_at_sequence_idx" ON "wallet_transactions"("created_at" DESC, "sequence" DESC);

-- CreateIndex
CREATE INDEX "wallet_transactions_payment_id_idx" ON "wallet_transactions"("payment_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_training_charge_id_idx" ON "wallet_transactions"("training_charge_id");

-- CreateIndex
CREATE INDEX "training_charges_attendance_id_idx" ON "training_charges"("attendance_id");

-- CreateIndex
CREATE INDEX "training_charges_wallet_id_idx" ON "training_charges"("wallet_id");

-- CreateIndex
CREATE INDEX "debts_user_id_idx" ON "debts"("user_id");

-- CreateIndex
CREATE INDEX "debt_settlements_transaction_id_idx" ON "debt_settlements"("transaction_id");

-- CreateIndex
CREATE INDEX "payments_created_at_idx" ON "payments"("created_at" DESC);

-- CreateIndex
CREATE INDEX "payments_wallet_id_idx" ON "payments"("wallet_id");

-- CreateIndex
CREATE INDEX "trainings_created_by_id_idx" ON "trainings"("created_by_id");

-- CreateIndex
CREATE INDEX "training_price_overrides_user_id_idx" ON "training_price_overrides"("user_id");

-- CreateIndex
CREATE INDEX "notification_deliveries_device_token_id_idx" ON "notification_deliveries"("device_token_id");

