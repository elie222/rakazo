ALTER TABLE "organization" ADD COLUMN "computerSize" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "computers" ADD COLUMN "runningSize" TEXT, ADD COLUMN "runningSizeSince" TIMESTAMP(3);
ALTER TABLE "computer_runs" ADD COLUMN "size" TEXT;
