ALTER TABLE "access_grants" ADD COLUMN "byokTier" TEXT;

CREATE TABLE "free_byok_tiers" (
    "organizationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "free_byok_tiers_pkey" PRIMARY KEY ("organizationId", "tier"),
    CONSTRAINT "free_byok_tiers_organizationId_fkey" FOREIGN KEY ("organizationId")
        REFERENCES "model_credit_accounts"("organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
