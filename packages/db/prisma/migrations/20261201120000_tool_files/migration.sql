-- Temporary tool files: files one tool hands to another without their bytes passing through
-- the model. Additive only: the previous release never writes these, and while both run during
-- a deploy it only ever sees the few temporary files the new one made.

-- A temporary file is an artifact with an expiry; files people and bots keep have none.
ALTER TABLE "artifacts" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- The sweep finds expired temporary files; kept files (no expiry) stay out of the index.
CREATE INDEX "artifacts_expiresAt_idx" ON "artifacts"("expiresAt") WHERE "expiresAt" IS NOT NULL;

-- Stdio MCP servers can name an env variable that receives their output folder.
ALTER TABLE "mcp_servers" ADD COLUMN "outputEnv" TEXT;

CREATE TABLE "tool_file_download_tokens" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usesLeft" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_file_download_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tool_file_download_tokens_tokenHash_key" ON "tool_file_download_tokens"("tokenHash");

CREATE INDEX "tool_file_download_tokens_artifactId_idx" ON "tool_file_download_tokens"("artifactId");

CREATE INDEX "tool_file_download_tokens_expiresAt_idx" ON "tool_file_download_tokens"("expiresAt");

ALTER TABLE "tool_file_download_tokens" ADD CONSTRAINT "tool_file_download_tokens_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tool_file_download_tokens" ADD CONSTRAINT "tool_file_download_tokens_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A download link belongs to its file's Space, like the file itself; the public download
-- route redeems it as a named system lookup by token hash.
ALTER TABLE "tool_file_download_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tool_file_download_tokens_tenant ON "tool_file_download_tokens"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY tool_file_download_tokens_system ON "tool_file_download_tokens"
  USING ((SELECT app_rls_bypass()));
