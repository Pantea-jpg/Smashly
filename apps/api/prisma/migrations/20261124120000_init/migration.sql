-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "TrainingStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ATTENDING', 'NOT_ATTENDING');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PENDING', 'PRESENT', 'ABSENT', 'EXCUSED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('ONLINE_TOP_UP', 'CASH_TOP_UP', 'TRAINING_PAYMENT', 'DEBT_PAYMENT', 'REFUND', 'ADJUSTMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('STRIPE', 'CASH', 'WALLET', 'SYSTEM');

-- CreateEnum
CREATE TYPE "PriceSource" AS ENUM ('TRAINING_DEFAULT', 'USER_STANDING_PRICE', 'TRAINING_OVERRIDE');

-- CreateEnum
CREATE TYPE "ChargeStatus" AS ENUM ('ACTIVE', 'REVERSED');

-- CreateEnum
CREATE TYPE "DebtSource" AS ENUM ('TRAINING_CHARGE', 'TOP_UP_REVERSAL');

-- CreateEnum
CREATE TYPE "DebtStatus" AS ENUM ('OPEN', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('REQUIRES_PAYMENT', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'REQUIRES_REVIEW', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('TRAINING_CREATED', 'TRAINING_UPDATED', 'TRAINING_CANCELLED', 'TRAINING_REMINDER', 'RESERVATION_CONFIRMED', 'ATTENDANCE_RECORDED', 'TRAINING_CHARGED', 'TOP_UP_SUCCEEDED', 'TOP_UP_FAILED', 'CASH_PAYMENT_RECORDED', 'LOW_BALANCE', 'DEBT_REMINDER');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('TRAININGS', 'PAYMENTS', 'REMINDERS');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('IOS', 'ANDROID', 'WEB');

-- CreateEnum
CREATE TYPE "PushProvider" AS ENUM ('APNS', 'FCM');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "email_verified_at" TIMESTAMPTZ,
    "last_login_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,
    "anonymized_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "user_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "phone" TEXT,
    "avatar_key" TEXT,
    "preferred_language" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "replaced_by_id" UUID,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "view_sessions" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "subject_user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "ended_at" TIMESTAMPTZ,
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "view_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "balance_minor" INTEGER NOT NULL DEFAULT 0,
    "debt_minor" INTEGER NOT NULL DEFAULT 0,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" "TransactionType" NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "wallet_delta_minor" INTEGER NOT NULL,
    "debt_delta_minor" INTEGER NOT NULL,
    "balance_before_minor" INTEGER NOT NULL,
    "balance_after_minor" INTEGER NOT NULL,
    "debt_before_minor" INTEGER NOT NULL,
    "debt_after_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "payment_method" "PaymentMethod" NOT NULL,
    "description" TEXT NOT NULL,
    "reason" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "group_id" UUID NOT NULL,
    "training_id" UUID,
    "training_charge_id" UUID,
    "payment_id" UUID,
    "created_by_admin_id" UUID,
    "reverses_transaction_id" UUID,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_charges" (
    "id" UUID NOT NULL,
    "training_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "attendance_id" UUID NOT NULL,
    "unit_price_minor" INTEGER NOT NULL,
    "price_source" "PriceSource" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "paid_from_wallet_minor" INTEGER NOT NULL,
    "shortfall_minor" INTEGER NOT NULL,
    "status" "ChargeStatus" NOT NULL DEFAULT 'ACTIVE',
    "reversed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "source" "DebtSource" NOT NULL,
    "source_transaction_id" UUID NOT NULL,
    "training_charge_id" UUID,
    "original_amount_minor" INTEGER NOT NULL,
    "outstanding_amount_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "DebtStatus" NOT NULL DEFAULT 'OPEN',
    "settled_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "debts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debt_settlements" (
    "id" UUID NOT NULL,
    "debt_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "debt_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'STRIPE',
    "provider_payment_id" TEXT,
    "provider_customer_id" TEXT,
    "amount_minor" INTEGER NOT NULL,
    "refunded_amount_minor" INTEGER NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'REQUIRES_PAYMENT',
    "method_type" TEXT,
    "failure_code" TEXT,
    "client_idempotency_key" TEXT NOT NULL,
    "succeeded_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,
    "error" TEXT,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_series" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT NOT NULL,
    "rrule" TEXT NOT NULL,
    "start_time_local" TEXT NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
    "capacity" INTEGER,
    "default_price_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "deadline_offset_min" INTEGER NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "training_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trainings" (
    "id" UUID NOT NULL,
    "series_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
    "capacity" INTEGER,
    "default_price_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "reservation_deadline" TIMESTAMPTZ NOT NULL,
    "status" "TrainingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "cancelled_at" TIMESTAMPTZ,
    "cancellation_reason" TEXT,
    "attendance_finalized_at" TIMESTAMPTZ,
    "attendance_finalized_by_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "trainings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_standing_prices" (
    "user_id" UUID NOT NULL,
    "price_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "set_by_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_standing_prices_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "training_price_overrides" (
    "id" UUID NOT NULL,
    "training_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "price_minor" INTEGER NOT NULL,
    "set_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "training_price_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_reservations" (
    "id" UUID NOT NULL,
    "training_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "ReservationStatus" NOT NULL,
    "responded_by_id" UUID NOT NULL,
    "responded_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "training_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendances" (
    "id" UUID NOT NULL,
    "training_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "marked_by_id" UUID,
    "marked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "attendances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "params" JSONB NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "push_enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id","category")
);

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "provider" "PushProvider" NOT NULL,
    "token" TEXT NOT NULL,
    "app_version" TEXT,
    "last_seen_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "device_token_id" UUID NOT NULL,
    "status" "DeliveryStatus" NOT NULL,
    "provider_message_id" TEXT,
    "error" TEXT,
    "attempted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_role" "Role",
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "view_session_id" UUID,
    "request_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "processed_at" TIMESTAMPTZ,
    "failed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "locked_until" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");

-- CreateIndex
CREATE INDEX "users_email_trgm" ON "users" USING GIN ("email" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "user_profiles_last_name_first_name_idx" ON "user_profiles"("last_name", "first_name");

-- CreateIndex
CREATE INDEX "user_profiles_first_name_trgm" ON "user_profiles" USING GIN ("first_name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "user_profiles_last_name_trgm" ON "user_profiles" USING GIN ("last_name" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_replaced_by_id_key" ON "refresh_tokens"("replaced_by_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_tokens_user_id_idx" ON "email_verification_tokens"("user_id");

-- CreateIndex
CREATE INDEX "view_sessions_admin_id_created_at_idx" ON "view_sessions"("admin_id", "created_at");

-- CreateIndex
CREATE INDEX "view_sessions_subject_user_id_idx" ON "view_sessions"("subject_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_user_id_currency_key" ON "wallets"("user_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_idempotency_key_key" ON "wallet_transactions"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_reverses_transaction_id_key" ON "wallet_transactions"("reverses_transaction_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_user_id_created_at_idx" ON "wallet_transactions"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "wallet_transactions_type_created_at_idx" ON "wallet_transactions"("type", "created_at");

-- CreateIndex
CREATE INDEX "wallet_transactions_training_id_idx" ON "wallet_transactions"("training_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_created_by_admin_id_created_at_idx" ON "wallet_transactions"("created_by_admin_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_transactions_group_id_idx" ON "wallet_transactions"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_wallet_id_sequence_key" ON "wallet_transactions"("wallet_id", "sequence");

-- CreateIndex
CREATE INDEX "training_charges_training_id_idx" ON "training_charges"("training_id");

-- CreateIndex
CREATE INDEX "training_charges_user_id_created_at_idx" ON "training_charges"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "training_charges_one_active" ON "training_charges"("training_id", "user_id") WHERE (status = 'ACTIVE');

-- CreateIndex
CREATE UNIQUE INDEX "debts_source_transaction_id_key" ON "debts"("source_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "debts_training_charge_id_key" ON "debts"("training_charge_id");

-- CreateIndex
CREATE INDEX "debts_wallet_id_status_created_at_idx" ON "debts"("wallet_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "debt_settlements_debt_id_transaction_id_key" ON "debt_settlements"("debt_id", "transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_payment_id_key" ON "payments"("provider_payment_id");

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_user_id_client_idempotency_key_key" ON "payments"("user_id", "client_idempotency_key");

-- CreateIndex
CREATE INDEX "stripe_events_type_received_at_idx" ON "stripe_events"("type", "received_at");

-- CreateIndex
CREATE INDEX "trainings_starts_at_idx" ON "trainings"("starts_at");

-- CreateIndex
CREATE INDEX "trainings_status_starts_at_idx" ON "trainings"("status", "starts_at");

-- CreateIndex
CREATE INDEX "trainings_series_id_idx" ON "trainings"("series_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_price_overrides_training_id_user_id_key" ON "training_price_overrides"("training_id", "user_id");

-- CreateIndex
CREATE INDEX "training_reservations_training_id_status_idx" ON "training_reservations"("training_id", "status");

-- CreateIndex
CREATE INDEX "training_reservations_user_id_idx" ON "training_reservations"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_reservations_training_id_user_id_key" ON "training_reservations"("training_id", "user_id");

-- CreateIndex
CREATE INDEX "attendances_user_id_created_at_idx" ON "attendances"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "attendances_training_id_user_id_key" ON "attendances"("training_id", "user_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");

-- CreateIndex
CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens"("user_id");

-- CreateIndex
CREATE INDEX "notification_deliveries_notification_id_idx" ON "notification_deliveries"("notification_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "outbox_events_processed_at_failed_at_available_at_idx" ON "outbox_events"("processed_at", "failed_at", "available_at");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_actor_id_key_key" ON "idempotency_records"("actor_id", "key");

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "view_sessions" ADD CONSTRAINT "view_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "view_sessions" ADD CONSTRAINT "view_sessions_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_training_id_fkey" FOREIGN KEY ("training_id") REFERENCES "trainings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_training_charge_id_fkey" FOREIGN KEY ("training_charge_id") REFERENCES "training_charges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_reverses_transaction_id_fkey" FOREIGN KEY ("reverses_transaction_id") REFERENCES "wallet_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_charges" ADD CONSTRAINT "training_charges_training_id_fkey" FOREIGN KEY ("training_id") REFERENCES "trainings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_charges" ADD CONSTRAINT "training_charges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_charges" ADD CONSTRAINT "training_charges_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_charges" ADD CONSTRAINT "training_charges_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "attendances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_source_transaction_id_fkey" FOREIGN KEY ("source_transaction_id") REFERENCES "wallet_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_training_charge_id_fkey" FOREIGN KEY ("training_charge_id") REFERENCES "training_charges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_settlements" ADD CONSTRAINT "debt_settlements_debt_id_fkey" FOREIGN KEY ("debt_id") REFERENCES "debts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_settlements" ADD CONSTRAINT "debt_settlements_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "wallet_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trainings" ADD CONSTRAINT "trainings_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "training_series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trainings" ADD CONSTRAINT "trainings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_standing_prices" ADD CONSTRAINT "user_standing_prices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_price_overrides" ADD CONSTRAINT "training_price_overrides_training_id_fkey" FOREIGN KEY ("training_id") REFERENCES "trainings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_price_overrides" ADD CONSTRAINT "training_price_overrides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_reservations" ADD CONSTRAINT "training_reservations_training_id_fkey" FOREIGN KEY ("training_id") REFERENCES "trainings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_reservations" ADD CONSTRAINT "training_reservations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_training_id_fkey" FOREIGN KEY ("training_id") REFERENCES "trainings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_device_token_id_fkey" FOREIGN KEY ("device_token_id") REFERENCES "device_tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


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
