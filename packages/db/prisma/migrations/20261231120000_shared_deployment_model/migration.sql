ALTER TABLE "deployment_settings"
  ADD COLUMN "sharedModelProvider" TEXT,
  ADD COLUMN "sharedModelId" TEXT,
  ADD COLUMN "sharedModelMethod" TEXT,
  ADD COLUMN "sharedModelRevision" TEXT,
  ADD COLUMN "sharedModelCipher" TEXT,
  ADD COLUMN "sharedModelDisabled" BOOLEAN NOT NULL DEFAULT false;
