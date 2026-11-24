CREATE TABLE "mobile_devices" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sessionId" TEXT NOT NULL REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "platform" TEXT NOT NULL CHECK ("platform" IN ('ios', 'android')),
  "name" TEXT,
  "lastSeenAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "mobile_devices_sessionId_key" ON "mobile_devices"("sessionId");
ALTER TABLE "mobile_devices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mobile_devices_account" ON "mobile_devices"
  USING (EXISTS (
    SELECT 1 FROM "session"
    WHERE "session"."id" = "mobile_devices"."sessionId"
      AND "session"."userId" = NULLIF(current_setting('app.user_id', true), '')
  ));
CREATE POLICY "mobile_devices_system" ON "mobile_devices"
  USING ((SELECT app_rls_bypass()));
