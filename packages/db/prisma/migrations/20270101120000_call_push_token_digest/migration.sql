-- Rename call_push_devices."expoTokenDigest" to a provider-neutral "pushTokenDigest". The old
-- column is dropped by the deferred migration that follows.
-- Hold the previous release's writes until the sync trigger exists, so the backfill misses none.
LOCK TABLE "call_push_devices" IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE "call_push_devices" ADD COLUMN "pushTokenDigest" TEXT UNIQUE;
UPDATE "call_push_devices" SET "pushTokenDigest" = "expoTokenDigest";
-- The previous release keeps writing "expoTokenDigest" during the deploy and this one writes
-- "pushTokenDigest": copy whichever column a write changed into the other until the drop.
CREATE FUNCTION call_push_token_digest_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."pushTokenDigest" := COALESCE(NEW."pushTokenDigest", NEW."expoTokenDigest");
    NEW."expoTokenDigest" := NEW."pushTokenDigest";
  ELSIF NEW."pushTokenDigest" IS DISTINCT FROM OLD."pushTokenDigest" THEN
    NEW."expoTokenDigest" := NEW."pushTokenDigest";
  ELSIF NEW."expoTokenDigest" IS DISTINCT FROM OLD."expoTokenDigest" THEN
    NEW."pushTokenDigest" := NEW."expoTokenDigest";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER call_push_token_digest_sync BEFORE INSERT OR UPDATE ON "call_push_devices"
  FOR EACH ROW EXECUTE FUNCTION call_push_token_digest_sync();
