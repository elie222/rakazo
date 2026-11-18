ALTER TABLE "meeting_sessions" ADD COLUMN "scheduledFor" TIMESTAMP(3);
CREATE INDEX "meeting_sessions_spaceId_scheduledFor_idx"
    ON "meeting_sessions"("spaceId", "scheduledFor");

CREATE TABLE "meeting_calendar_connections" (
    "id" TEXT PRIMARY KEY,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalCalendarId" TEXT,
    "disconnecting" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventsDigest" TEXT,
    UNIQUE ("spaceId", "userId"),
    UNIQUE ("provider", "externalCalendarId")
);

CREATE TABLE "meeting_calendar_authorizations" (
    "id" TEXT PRIMARY KEY,
    "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "botId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sessionId" TEXT,
    UNIQUE ("spaceId", "userId")
);

CREATE TABLE "meeting_calendar_rules" (
    "connectionId" TEXT NOT NULL REFERENCES "meeting_calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "scope" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "botId" TEXT,
    "eventStartsAt" TIMESTAMP(3),
    PRIMARY KEY ("connectionId", "scope", "targetId")
);

CREATE TABLE "meeting_calendar_bookings" (
    "connectionId" TEXT NOT NULL REFERENCES "meeting_calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "eventId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "linked" BOOLEAN NOT NULL DEFAULT false,
    "configDigest" TEXT NOT NULL,
    PRIMARY KEY ("connectionId", "eventId")
);
CREATE INDEX "meeting_calendar_bookings_sessionId_idx" ON "meeting_calendar_bookings"("sessionId");

ALTER TABLE "meeting_calendar_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_calendar_authorizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_calendar_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_calendar_bookings" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "meeting_calendar_connections_tenant" ON "meeting_calendar_connections"
    USING ("spaceId" = current_setting('app.space_id', true) AND "userId" = current_setting('app.user_id', true));
CREATE POLICY "meeting_calendar_connections_system" ON "meeting_calendar_connections" USING ((SELECT app_rls_bypass()));
CREATE POLICY "meeting_calendar_authorizations_tenant" ON "meeting_calendar_authorizations"
    USING ("spaceId" = current_setting('app.space_id', true) AND "userId" = current_setting('app.user_id', true));
CREATE POLICY "meeting_calendar_authorizations_system" ON "meeting_calendar_authorizations" USING ((SELECT app_rls_bypass()));
CREATE POLICY "meeting_calendar_rules_tenant" ON "meeting_calendar_rules"
    USING (EXISTS (SELECT 1 FROM "meeting_calendar_connections" WHERE "id" = "connectionId"));
CREATE POLICY "meeting_calendar_rules_system" ON "meeting_calendar_rules" USING ((SELECT app_rls_bypass()));
CREATE POLICY "meeting_calendar_bookings_tenant" ON "meeting_calendar_bookings"
    USING (EXISTS (SELECT 1 FROM "meeting_calendar_connections" WHERE "id" = "connectionId"));
CREATE POLICY "meeting_calendar_bookings_system" ON "meeting_calendar_bookings" USING ((SELECT app_rls_bypass()));
