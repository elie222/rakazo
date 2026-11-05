-- Additive: older releases never read or write these columns.
ALTER TABLE "runs" ADD COLUMN "memoryCaptureScope" TEXT;
ALTER TABLE "runs" ADD COLUMN "memoryCapturePayload" JSONB;
