-- Additive: older releases never read it.
CREATE TABLE "desktop_push_devices" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sessionId" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "liveSpaceId" TEXT,
  "liveUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "desktop_push_devices_userId_sessionId_idx" ON "desktop_push_devices"("userId", "sessionId");
ALTER TABLE "desktop_push_devices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY desktop_push_devices_system ON "desktop_push_devices"
  USING ((SELECT app_rls_bypass()));
