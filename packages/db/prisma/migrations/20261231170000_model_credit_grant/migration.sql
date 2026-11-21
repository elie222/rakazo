-- Additive: the previous release neither reads nor writes these columns or grant entries.
ALTER TABLE "user" ADD COLUMN "modelCreditGrantedAt" TIMESTAMP(3);
ALTER TABLE model_credit_accounts ADD COLUMN "grantSpentAt" TIMESTAMP(3);

-- A grant entry is journalled as a grant, not as a purchase.
CREATE OR REPLACE FUNCTION billing_audit_credit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE delta BIGINT; event_kind TEXT;
BEGIN
 delta := NEW."amountMicros" - CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD."amountMicros" END;
 event_kind := CASE
  WHEN TG_OP='INSERT' AND NEW.pending THEN 'reservation'
  WHEN TG_OP='INSERT' AND NEW.source LIKE 'grant:%' THEN 'grant'
  WHEN TG_OP='INSERT' THEN 'purchase'
  WHEN OLD.pending AND NOT NEW.pending THEN 'settlement'
  WHEN NEW.source LIKE 'purchase:%' AND delta < 0 THEN 'refund'
  WHEN delta <> 0 THEN 'correction'
  WHEN NEW.usage IS DISTINCT FROM OLD.usage THEN 'receipt'
  WHEN NEW."providerRequestId" IS DISTINCT FROM OLD."providerRequestId" THEN 'provider_request'
  ELSE 'reconciliation' END;
 INSERT INTO public.billing_audit_events(source,kind,"organizationId","callId","userId","spaceId",provider,model,"providerRequestId","amountMicros",details)
 VALUES ('credit:'||NEW.id||':'||NEW."auditRevision",event_kind,NEW."organizationId",NEW."callId",NEW."userId",NEW."spaceId",NEW.provider,NEW.model,NEW."providerRequestId",delta,
 jsonb_build_object('entry',to_jsonb(NEW),'previous',CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END));
 RETURN NEW;
END $$;
