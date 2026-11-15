-- Additive: the previous release never reads these.
ALTER TABLE "user" ADD COLUMN "signupPartnerClickId" TEXT;

CREATE TABLE "partner_sales" (
    "invoiceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refundedAt" TIMESTAMP(3),

    CONSTRAINT "partner_sales_pkey" PRIMARY KEY ("invoiceId")
);

CREATE INDEX "partner_sales_organizationId_idx" ON "partner_sales"("organizationId");

ALTER TABLE "partner_sales" ADD CONSTRAINT "partner_sales_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
