-- Additive: the previous release never reads this table.
CREATE TABLE "access_grants" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "creditCents" INTEGER NOT NULL DEFAULT 0,
    "freeMonths" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "organizationId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_grants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "access_grants_email_idx" ON "access_grants"("email");

CREATE INDEX "access_grants_createdAt_idx" ON "access_grants"("createdAt");
