-- Additive: older releases never read or write this column.
ALTER TABLE "runs" ADD COLUMN "memoryCaptureAttempts" INTEGER NOT NULL DEFAULT 0;
