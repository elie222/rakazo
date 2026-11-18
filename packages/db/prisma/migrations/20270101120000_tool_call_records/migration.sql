-- A short, redacted trace of each tool call, so a failure can be explained after the run ends.
ALTER TABLE "spaces" ADD COLUMN "keepToolCallRecords" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "tool_call_records" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "executionId" TEXT NOT NULL,
  "tool" TEXT NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "outcome" TEXT NOT NULL,
  "arguments" TEXT,
  "error" TEXT,
  "resultBytes" INTEGER,
  "resultShortened" BOOLEAN NOT NULL DEFAULT false,
  "resultHead" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tool_call_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tool_call_records_runId_createdAt_idx" ON "tool_call_records"("runId", "createdAt");
CREATE INDEX "tool_call_records_createdAt_idx" ON "tool_call_records"("createdAt");

ALTER TABLE "tool_call_records" ADD CONSTRAINT "tool_call_records_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tool_call_records" ADD CONSTRAINT "tool_call_records_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A call's trace belongs to its Space, and the retention sweep deletes across all of them as the system.
ALTER TABLE "tool_call_records" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tool_call_records_tenant ON "tool_call_records"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY tool_call_records_system ON "tool_call_records"
  USING ((SELECT app_rls_bypass()));

GRANT SELECT, INSERT, DELETE ON "tool_call_records" TO rakazo_app;
