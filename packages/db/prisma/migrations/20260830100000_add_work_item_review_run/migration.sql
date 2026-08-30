ALTER TABLE "work_item_reviews" ADD COLUMN "runId" TEXT;
CREATE UNIQUE INDEX "work_item_reviews_runId_key" ON "work_item_reviews"("runId");
ALTER TABLE "work_item_reviews" ADD CONSTRAINT "work_item_reviews_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
