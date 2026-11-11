-- CreateTable
CREATE TABLE "service_event_streams" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_event_streams_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "service_event_streams_credentialId_idx" ON "service_event_streams"("credentialId");

ALTER TABLE "service_event_streams" ADD CONSTRAINT "service_event_streams_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "service_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "service_event_streams" ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_event_streams_tenant ON "service_event_streams"
  USING (
    "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND "spaceId" = NULLIF(current_setting('app.space_id', true), '')
  );
CREATE POLICY service_event_streams_system ON "service_event_streams"
  USING ((SELECT app_rls_bypass()));
