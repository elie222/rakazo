-- Usage detail needs the failure reason and the transcription measurements.
-- Additive nullable columns only, so the previous release keeps working.
ALTER TABLE "usage_records" ADD COLUMN "failureReason" TEXT;
ALTER TABLE "usage_records" ADD COLUMN "audioSeconds" DOUBLE PRECISION;
ALTER TABLE "usage_records" ADD COLUMN "audioBytes" INTEGER;
ALTER TABLE "usage_records" ADD COLUMN "transcribedChars" INTEGER;
