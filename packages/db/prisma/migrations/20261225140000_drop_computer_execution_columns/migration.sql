-- deferred
-- Computer execution ownership lives in computer_execution_leases; nothing reads or writes these
-- columns any more. Dropping executionRunId drops its index with it.
ALTER TABLE "computers" DROP COLUMN "executionRunId",
DROP COLUMN "executionBotId",
DROP COLUMN "executionLeaseExpiresAt",
DROP COLUMN "executionFence";
