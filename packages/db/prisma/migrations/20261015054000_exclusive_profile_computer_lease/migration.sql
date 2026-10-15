ALTER TABLE "computer_execution_leases" ADD COLUMN "exclusive" BOOLEAN NOT NULL DEFAULT false;

-- Explicit primary profiles serialize access to a shared checkout. Legacy Pi bots
-- remain concurrent when no exclusive lease is held. The parent row lock closes
-- the check/insert race across different per-bot lease rows and every caller.
CREATE FUNCTION "enforce_exclusive_computer_lease"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Prisma stores DateTime in UTC timestamp-without-time-zone columns.
  IF NEW."expiresAt" <= timezone('UTC', clock_timestamp()) THEN RETURN NEW; END IF;
  PERFORM id FROM "computers" WHERE id = NEW."computerId" FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM "computer_execution_leases"
    WHERE "computerId" = NEW."computerId" AND "botId" <> NEW."botId"
      AND "expiresAt" > timezone('UTC', clock_timestamp())
      AND (NEW."exclusive" OR "exclusive")
  ) THEN
    -- The acquisition helper already maps uniqueness conflicts to a busy/requeue.
    RAISE EXCEPTION 'Computer is busy' USING ERRCODE = '23505',
      CONSTRAINT = 'computer_execution_lease_exclusive';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "computer_execution_lease_exclusive"
BEFORE INSERT OR UPDATE OF "computerId", "botId", "expiresAt", "exclusive"
ON "computer_execution_leases" FOR EACH ROW EXECUTE FUNCTION "enforce_exclusive_computer_lease"();
