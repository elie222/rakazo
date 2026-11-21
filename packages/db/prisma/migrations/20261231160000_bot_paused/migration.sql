-- Additive: a nullable column the previous release never reads or writes.
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "pausedAt" TIMESTAMP(3);
