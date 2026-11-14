-- AlterTable
ALTER TABLE "routines" ADD COLUMN "promptCredentialId" TEXT;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN "promptCredentialId" TEXT;
