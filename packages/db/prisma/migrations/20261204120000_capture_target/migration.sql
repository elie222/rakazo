-- Keep earlier pending turns bound to the connection resolved by their executor.
-- NULL deliberately leaves old captures unknown; never infer their target from current settings.
ALTER TABLE "runs" ADD COLUMN "memoryCaptureTarget" TEXT;
