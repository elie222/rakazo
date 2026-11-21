CREATE TABLE "routine_run_records" (
    "id" TEXT NOT NULL,
    "routineId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER,
    "messageSent" BOOLEAN NOT NULL DEFAULT false,
    "summary" TEXT,
    "items" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routine_run_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "routine_run_records_routineId_ranAt_idx" ON "routine_run_records" ("routineId", "ranAt");

ALTER TABLE "routine_run_records" ADD CONSTRAINT "routine_run_records_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "routines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routine_run_records" ADD CONSTRAINT "routine_run_records_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
