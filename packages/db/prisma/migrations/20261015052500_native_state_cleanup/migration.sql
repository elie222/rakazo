-- Tombstones intentionally have no cascading foreign keys.
CREATE TABLE "native_state_cleanups" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "computerId" TEXT NOT NULL,
  "scope" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  CONSTRAINT "native_state_cleanups_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "native_state_cleanups_computerId_idx" ON "native_state_cleanups"("computerId");
CREATE INDEX "native_state_cleanups_createdAt_idx" ON "native_state_cleanups"("createdAt");
