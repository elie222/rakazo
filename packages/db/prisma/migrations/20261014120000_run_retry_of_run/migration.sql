-- AlterTable
ALTER TABLE "runs" ADD COLUMN "retryOfRunId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "runs_retryOfRunId_key" ON "runs"("retryOfRunId");
