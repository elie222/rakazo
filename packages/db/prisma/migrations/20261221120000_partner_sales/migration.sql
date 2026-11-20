-- Additive: the previous release never reads these.
ALTER TABLE "user" ADD COLUMN "signupPartnerClickId" TEXT;

CREATE TABLE "partner_sales" (
    "invoiceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "invoiceCreatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reportedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),

    CONSTRAINT "partner_sales_pkey" PRIMARY KEY ("invoiceId")
);

CREATE INDEX "partner_sales_customerId_idx" ON "partner_sales"("customerId");
