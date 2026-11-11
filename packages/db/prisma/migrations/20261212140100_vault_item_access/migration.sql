-- Each vault item says whether bots may use it. Additive: existing items keep "allow", and the
-- previous release ignores the column, so rolling back to it lets bots use blocked items.
ALTER TABLE "vault_credentials" ADD COLUMN "policy" TEXT NOT NULL DEFAULT 'allow';
