-- Legacy binaries cannot enforce item policies. Hide all vault rows from them, even in a
-- system context, during rollout and rollback. New connections attest support alongside
-- their tenant/system settings. This deliberately disables the legacy vault until upgraded.
-- RESTRICTIVE intersects every permissive tenant and system policy, including writes.
CREATE POLICY vault_credentials_access_version ON "vault_credentials" AS RESTRICTIVE
  USING (current_setting('app.vault_access_version', true) = '1');

-- A legacy run must not fall back to a run-only login/code instead of checking the vault.
CREATE POLICY secrets_vault_access_version ON "secrets" AS RESTRICTIVE
  USING ("kind" NOT LIKE 'run-login:%' AND "kind" NOT LIKE 'run-code:%'
    AND "kind" NOT LIKE 'run-code-spent:%' AND "kind" NOT LIKE 'run-secret:%'
    OR current_setting('app.vault_access_version', true) = '1');
