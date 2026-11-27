ALTER TABLE "page_versions" ADD COLUMN "abilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
