-- Durable association between organization work and the existing Rakazo run executor.
CREATE TABLE "work_item_executions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "result" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_item_executions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "work_item_executions_runId_key" ON "work_item_executions"("runId");
CREATE UNIQUE INDEX "work_item_executions_workItemId_attempt_key" ON "work_item_executions"("workItemId", "attempt");
CREATE INDEX "work_item_executions_workspaceId_status_idx" ON "work_item_executions"("workspaceId", "status");
CREATE INDEX "work_item_executions_workItemId_createdAt_idx" ON "work_item_executions"("workItemId", "createdAt");

ALTER TABLE "work_item_executions" ADD CONSTRAINT "work_item_executions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "work_item_executions" ADD CONSTRAINT "work_item_executions_workItemId_fkey"
  FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "work_item_executions" ADD CONSTRAINT "work_item_executions_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
