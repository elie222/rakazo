ALTER TABLE "member" ADD COLUMN "onboardedAt" TIMESTAMP(3);
ALTER TABLE "spaces"
  ADD COLUMN "deletingAt" TIMESTAMP(3),
  ADD COLUMN "deletionClaimId" TEXT;

-- Existing installations predate the durable first-use signal, and deleted
-- Spaces may already have cascaded their only usage history. Treat every
-- existing organization membership as established; only memberships created
-- after this migration begin with onboarding incomplete.
UPDATE "member"
SET "onboardedAt" = "createdAt";
