-- The pending index build leaves the deploy's connection-wide lock timeout unset.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "messages" ADD COLUMN "pinnedAt" TIMESTAMP(3);
