-- Evaluation Pack v1 is additive and disabled by default. This migration creates
-- only its one-to-one policy record; it does not rewrite existing Run rows.
CREATE TABLE "run_policies" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "allowedToolIds" JSONB NOT NULL,
    "evidenceRoot" TEXT NOT NULL,
    "budgets" JSONB NOT NULL,
    "policyHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "turns" INTEGER NOT NULL DEFAULT 0,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicrodollars" INTEGER NOT NULL DEFAULT 0,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "accountingFence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "run_policies_runId_key" ON "run_policies"("runId");
CREATE INDEX "run_policies_workspaceId_campaignId_status_idx"
ON "run_policies"("workspaceId", "campaignId", "status");
CREATE INDEX "run_policies_expiresAt_revokedAt_idx"
ON "run_policies"("expiresAt", "revokedAt");

ALTER TABLE "run_policies" ADD CONSTRAINT "run_policies_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "run_policies" ADD CONSTRAINT "run_policies_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
