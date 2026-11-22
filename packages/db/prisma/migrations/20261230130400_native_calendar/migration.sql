ALTER TABLE "messages" ADD COLUMN "nativeCalendarSessionId" TEXT,
    ADD COLUMN "nativeCalendarDeviceDigest" TEXT;

CREATE TABLE "native_calendar_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "sessionId" TEXT NOT NULL,
    "deviceDigest" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "operation" JSONB,
    "result" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL
);

CREATE INDEX "native_calendar_requests_sessionId_status_expiresAt_idx"
    ON "native_calendar_requests"("sessionId", "status", "expiresAt");
CREATE INDEX "native_calendar_requests_expiresAt_idx" ON "native_calendar_requests"("expiresAt");
CREATE INDEX "native_calendar_requests_runId_idx" ON "native_calendar_requests"("runId");
CREATE INDEX "native_calendar_requests_userId_idx" ON "native_calendar_requests"("userId");
ALTER TABLE "native_calendar_requests" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "native_calendar_requests_tenant" ON "native_calendar_requests"
    USING ("spaceId" = current_setting('app.space_id', true) AND "userId" = current_setting('app.user_id', true));
CREATE POLICY "native_calendar_requests_system" ON "native_calendar_requests"
    USING ((SELECT app_rls_bypass()));
