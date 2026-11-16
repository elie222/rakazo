-- A SECURITY DEFINER function searches the caller's temporary schema first unless pg_temp is
-- listed, so a session could shadow a type or table the function uses and run code as the owner.
ALTER FUNCTION billing_audit_credit() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION billing_audit_usage() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION billing_audit_account_closed() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION billing_audit_lot() SET search_path = pg_catalog, public, pg_temp;

-- Trigger functions only run from their triggers, which do not check EXECUTE.
REVOKE EXECUTE ON FUNCTION billing_audit_credit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION billing_audit_usage() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION billing_audit_account_closed() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION billing_audit_lot() FROM PUBLIC;
