-- deferred
-- Billing checkout, cloud-agent polling and home deletion notices hold the shared `leases` table;
-- nothing reads or writes these claim columns any more.
ALTER TABLE "billing_accounts" DROP COLUMN "checkoutLeaseExpiresAt",
DROP COLUMN "checkoutLeaseId";

ALTER TABLE "cloud_agents" DROP COLUMN "leaseExpiresAt",
DROP COLUMN "leaseToken";

ALTER TABLE "home_deletion_notices" DROP COLUMN "claimExpiresAt",
DROP COLUMN "claimId";
