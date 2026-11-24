ALTER TABLE "meeting_sessions" ADD COLUMN "shareTranscript" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "meeting_calendar_rules" ADD COLUMN "shareTranscript" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "meeting_calendar_bookings" ADD COLUMN "shareTranscript" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "artifacts" ADD COLUMN "meetingSessionId" TEXT;
CREATE UNIQUE INDEX "artifacts_meetingSessionId_key" ON "artifacts"("meetingSessionId");
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_meetingSessionId_fkey"
  FOREIGN KEY ("meetingSessionId") REFERENCES "meeting_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "meeting_sessions_shared_recent" ON "meeting_sessions" ("spaceId", "botId", "closedAt" DESC, "id" DESC)
  WHERE "shareTranscript" AND "closedAt" IS NOT NULL AND "status" IN ('processing', 'ready');

CREATE POLICY "meeting_sessions_shared_transcripts" ON "meeting_sessions" FOR SELECT
  USING (
    "spaceId" = current_setting('app.space_id', true)
    AND "shareTranscript"
    AND "closedAt" IS NOT NULL
    AND "status" IN ('processing', 'ready')
  );
