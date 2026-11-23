ALTER TABLE "model_credit_entries" ADD COLUMN "disputedMicros" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "purchaseRead" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "model_credit_accounts" ADD COLUMN "purchaseReadsStarted" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "purchaseReadApplied" BIGINT NOT NULL DEFAULT 0;
