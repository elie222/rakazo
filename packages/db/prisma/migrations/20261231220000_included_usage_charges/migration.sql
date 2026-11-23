-- Additive: older releases never read or write this table.
CREATE TABLE "included_usage_charges" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountMicros" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "included_usage_charges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "included_usage_charges_source_key" ON "included_usage_charges"("source");

CREATE INDEX "included_usage_charges_organizationId_createdAt_idx"
    ON "included_usage_charges"("organizationId", "createdAt");

ALTER TABLE "included_usage_charges" ADD CONSTRAINT "included_usage_charges_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Written and read only by the system on an organization's behalf.
ALTER TABLE "included_usage_charges" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "included_usage_charges_system" ON "included_usage_charges" USING ((SELECT app_rls_bypass()));
