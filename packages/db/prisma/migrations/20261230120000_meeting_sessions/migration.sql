CREATE TABLE "meeting_sessions" (
    "id" TEXT PRIMARY KEY,
    "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "provider" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "meetingUrl" TEXT,
    "activeKey" TEXT UNIQUE,
    "externalId" TEXT,
    "recordingId" TEXT,
    "transcriptId" TEXT,
    "transcript" TEXT,
    "error" TEXT,
    "requestedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE ("provider", "externalId")
);

CREATE INDEX "meeting_sessions_spaceId_userId_botId_createdAt_idx"
    ON "meeting_sessions"("spaceId", "userId", "botId", "createdAt");

CREATE INDEX "meeting_sessions_spaceId_createdAt_idx" ON "meeting_sessions"("spaceId", "createdAt");
CREATE INDEX "meeting_sessions_userId_idx" ON "meeting_sessions"("userId");

ALTER TABLE "meeting_sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "meeting_sessions_tenant" ON "meeting_sessions"
    USING ("spaceId" = current_setting('app.space_id', true) AND "userId" = current_setting('app.user_id', true));
CREATE POLICY "meeting_sessions_system" ON "meeting_sessions"
    USING ((SELECT app_rls_bypass()));
