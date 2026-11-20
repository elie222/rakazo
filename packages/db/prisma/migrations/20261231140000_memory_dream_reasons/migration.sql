-- Additive: older releases keep writing bots and dreams without these columns.
ALTER TABLE "bots" ADD COLUMN "memoryTidiedHash" TEXT;
ALTER TABLE "memory_dreams" ADD COLUMN "reason" TEXT;
