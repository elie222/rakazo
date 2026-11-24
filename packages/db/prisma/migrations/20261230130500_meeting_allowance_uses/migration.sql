CREATE TABLE "meeting_allowance_uses" (
    "id" TEXT PRIMARY KEY,
    "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "countedAt" TIMESTAMP(3) NOT NULL
);

CREATE INDEX "meeting_allowance_uses_spaceId_countedAt_idx"
    ON "meeting_allowance_uses"("spaceId", "countedAt");

ALTER TABLE "meeting_allowance_uses" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "meeting_allowance_uses_system" ON "meeting_allowance_uses"
    USING ((SELECT app_rls_bypass()));
