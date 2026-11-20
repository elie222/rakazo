-- Additive: older releases keep writing revisions and dreams without these columns.
ALTER TABLE "memory_revisions" ADD COLUMN "sourceKind" TEXT;
ALTER TABLE "memory_dreams" ADD COLUMN "undoneAt" TIMESTAMP(3);
