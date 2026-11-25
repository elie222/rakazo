-- Additive: older releases never read or write this table.
CREATE TABLE "media_charges" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountMicros" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_charges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "media_charges_source_key" ON "media_charges"("source");

CREATE INDEX "media_charges_organizationId_createdAt_idx"
    ON "media_charges"("organizationId", "createdAt");

ALTER TABLE "media_charges" ADD CONSTRAINT "media_charges_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Written and read only by the system on an organization's behalf.
ALTER TABLE "media_charges" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "media_charges_system" ON "media_charges" USING ((SELECT app_rls_bypass()));
