ALTER TABLE "runs" ADD COLUMN "nativeDmResumeGrant" TEXT;

CREATE TABLE "native_dm_sessions" (
    "threadId" TEXT PRIMARY KEY REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "sourceId" TEXT NOT NULL UNIQUE REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "replyId" TEXT NOT NULL UNIQUE REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ciphertext" TEXT NOT NULL CHECK ("ciphertext" LIKE 'rkz1:%')
);
CREATE INDEX "native_dm_sessions_expiresAt_idx" ON "native_dm_sessions"("expiresAt");
ALTER TABLE "native_dm_sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY native_dm_sessions_owner ON "native_dm_sessions"
    USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
      AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY native_dm_sessions_system ON "native_dm_sessions"
    USING ((SELECT app_rls_bypass()));
