ALTER TABLE "model_credit_entries" ADD COLUMN "disputedMicros" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "syncedAt" TIMESTAMP(3);
