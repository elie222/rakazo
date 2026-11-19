-- Additive: older releases never read or write this table.
CREATE TABLE "computer_allowance_grants" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "computer_allowance_grants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "computer_allowance_grants_organizationId_createdAt_idx"
    ON "computer_allowance_grants"("organizationId", "createdAt");

ALTER TABLE "computer_allowance_grants" ADD CONSTRAINT "computer_allowance_grants_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
