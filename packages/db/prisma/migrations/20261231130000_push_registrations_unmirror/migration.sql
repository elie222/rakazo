-- While the previous release still sends from push_tokens, a device this release hands to another
-- account or unregisters must leave that table too, or old workers keep pushing to it. Only a
-- database that has not yet dropped push_tokens gets the trigger. A delete made by a trigger, such
-- as push_tokens_mirror copying a previous-release write, is left alone so it never undoes it.
CREATE OR REPLACE FUNCTION push_registrations_unmirror() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() = 1 AND to_regclass('push_tokens') IS NOT NULL THEN
    DELETE FROM "push_tokens" WHERE "userId" = OLD."userId" AND "tokenDigest" = OLD."tokenDigest";
  END IF;
  RETURN OLD;
END $$;
DO $$
BEGIN
  IF to_regclass('push_tokens') IS NOT NULL THEN
    CREATE TRIGGER push_registrations_unmirror AFTER DELETE ON "push_registrations"
      FOR EACH ROW EXECUTE FUNCTION push_registrations_unmirror();
  END IF;
END $$;
