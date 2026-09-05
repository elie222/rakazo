CREATE TABLE "workforce_connections" (
 "id" TEXT PRIMARY KEY, "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
 "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE, "endpoint" TEXT NOT NULL,
 "credential" TEXT NOT NULL, "companyName" TEXT NOT NULL, "companySlug" TEXT NOT NULL,
 "enabled" BOOLEAN NOT NULL DEFAULT false, "workers" JSONB NOT NULL DEFAULT '[]',
 "lastSyncedAt" TIMESTAMP(3), "lastError" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "workforce_connections_spaceId_userId_key" ON "workforce_connections"("spaceId", "userId");
CREATE TABLE "workforce_assignments" (
 "id" TEXT PRIMARY KEY, "connectionId" TEXT NOT NULL REFERENCES "workforce_connections"("id") ON DELETE CASCADE,
 "dispatchId" TEXT NOT NULL, "seq" INTEGER NOT NULL, "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
 "runId" TEXT REFERENCES "runs"("id") ON DELETE SET NULL, "acknowledged" BOOLEAN NOT NULL DEFAULT false,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "workforce_assignments_connectionId_dispatchId_key" ON "workforce_assignments"("connectionId", "dispatchId");
CREATE INDEX "workforce_assignments_connectionId_acknowledged_idx" ON "workforce_assignments"("connectionId", "acknowledged");
