-- deferred
-- The signup policy is read from the environment; nothing reads or writes these columns any more.
ALTER TABLE "deployment_settings" DROP COLUMN "signupAllowlist",
DROP COLUMN "signupPolicyInitialized",
DROP COLUMN "signupsEnabled";
