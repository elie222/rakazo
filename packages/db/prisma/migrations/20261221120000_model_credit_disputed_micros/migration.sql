ALTER TABLE "model_credit_entries" ADD COLUMN "disputedMicros" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "model_credit_accounts" ADD COLUMN "purchasesSyncedAt" TIMESTAMP(3);
