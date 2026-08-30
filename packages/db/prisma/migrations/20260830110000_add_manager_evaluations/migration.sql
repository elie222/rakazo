CREATE TABLE "manager_evaluations" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "managerBotId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "runId" TEXT,
  "planningKey" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "result" JSONB NOT NULL DEFAULT '{}',
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "manager_evaluations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "manager_evaluations_runId_key" ON "manager_evaluations"("runId");
CREATE UNIQUE INDEX "manager_evaluations_planningKey_key" ON "manager_evaluations"("planningKey");
CREATE INDEX "manager_evaluations_workspaceId_managerBotId_status_idx" ON "manager_evaluations"("workspaceId", "managerBotId", "status");
CREATE INDEX "manager_evaluations_projectId_createdAt_idx" ON "manager_evaluations"("projectId", "createdAt");

ALTER TABLE "manager_evaluations" ADD CONSTRAINT "manager_evaluations_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "manager_evaluations" ADD CONSTRAINT "manager_evaluations_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "manager_evaluations" ADD CONSTRAINT "manager_evaluations_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
