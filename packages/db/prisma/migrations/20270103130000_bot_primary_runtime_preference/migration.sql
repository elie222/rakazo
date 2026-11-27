ALTER TABLE "bots"
    ADD COLUMN "primaryRuntimePreference" TEXT,
    ADD COLUMN "primaryRuntimeRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "runs"
    ADD COLUMN "primaryRuntimeRevision" INTEGER NOT NULL DEFAULT 0;
