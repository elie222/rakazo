ALTER TABLE "organization_logins"
  ADD COLUMN "sessionCipher" TEXT,
  ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
