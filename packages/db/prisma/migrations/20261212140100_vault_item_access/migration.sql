-- Additive vault access settings. The legacy access guard migration prevents older
-- runtime connections from using the vault without enforcing these settings.
ALTER TABLE "vault_credentials" ADD COLUMN "policy" TEXT NOT NULL DEFAULT 'allow';
