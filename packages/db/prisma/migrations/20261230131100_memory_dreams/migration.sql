-- CreateTable
CREATE TABLE "memory_dreams" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT,
    "runId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "summary" TEXT,
    "changedPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceSeq" INTEGER,
    "errorKind" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_dreams_pkey" PRIMARY KEY ("id")
);

-- Same policies as memory_documents (20261021140000_row_level_security).
ALTER TABLE "memory_dreams" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "memory_dreams_tenant" ON "memory_dreams"
    USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY "memory_dreams_system" ON "memory_dreams"
    USING ((SELECT app_rls_bypass()));

-- CreateIndex
CREATE UNIQUE INDEX "memory_dreams_runId_key" ON "memory_dreams"("runId");

-- CreateIndex
CREATE INDEX "memory_dreams_botId_status_createdAt_idx" ON "memory_dreams"("botId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "memory_dreams_spaceId_idx" ON "memory_dreams"("spaceId");

-- AddForeignKey
ALTER TABLE "memory_dreams" ADD CONSTRAINT "memory_dreams_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_dreams" ADD CONSTRAINT "memory_dreams_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_dreams" ADD CONSTRAINT "memory_dreams_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_dreams" ADD CONSTRAINT "memory_dreams_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
