-- Additive: old workers do not read or write the connection capture scheduling state.
ALTER TABLE "space_memory_configs"
  ADD COLUMN "captureBackoffRevision" TEXT,
  ADD COLUMN "captureBackoffFailures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "captureBackoffUntil" TIMESTAMP(3),
  ADD COLUMN "captureLeaseToken" TEXT;
