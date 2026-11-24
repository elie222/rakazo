-- Additive: the previous release never reads or writes this column.
ALTER TABLE "routines" ADD COLUMN "computerPromptHash" TEXT;

-- Whatever code writes the row, a change to what the owner approved turns "Use my computer" off.
-- Only the app's own route sets the hash, in the same update that changes the prompt.
CREATE OR REPLACE FUNCTION clear_routine_computer_prompt_hash() RETURNS trigger
LANGUAGE plpgsql AS $clear$
BEGIN
  IF NEW."computerPromptHash" IS NOT NULL
     AND NEW."computerPromptHash" IS NOT DISTINCT FROM OLD."computerPromptHash"
     AND (NEW.prompt IS DISTINCT FROM OLD.prompt
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."botId" IS DISTINCT FROM OLD."botId"
       OR NEW."inChat"
       OR NEW.watch IS NOT NULL) THEN
    NEW."computerPromptHash" := NULL;
  END IF;
  RETURN NEW;
END;
$clear$;
DROP TRIGGER IF EXISTS routines_clear_computer_prompt_hash ON routines;
CREATE TRIGGER routines_clear_computer_prompt_hash BEFORE UPDATE ON routines
FOR EACH ROW EXECUTE FUNCTION clear_routine_computer_prompt_hash();

-- Pairing another computer or unpairing one turns "Use my computer" off for all of that person's
-- routines, so a computer they pair later never gets a routine they approved for another. Runs as
-- the owner because a revoke happens outside any Space, where row security hides routines.
CREATE OR REPLACE FUNCTION clear_routine_computer_on_device_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $clear$
BEGIN
  -- Shared with the route that turns it on (lockOwnerComputerApproval), which checks pairing
  -- and writes the approval under it, so neither can land between the other's check and write.
  PERFORM pg_advisory_xact_lock(hashtext('routine_computer'), hashtext(COALESCE(NEW."userId", OLD."userId")));
  UPDATE routines SET "computerPromptHash" = NULL
  WHERE "userId" = COALESCE(NEW."userId", OLD."userId") AND "computerPromptHash" IS NOT NULL;
  RETURN NULL;
END;
$clear$;
REVOKE EXECUTE ON FUNCTION clear_routine_computer_on_device_change() FROM PUBLIC;
DROP TRIGGER IF EXISTS user_devices_pair_clears_routine_computer ON user_devices;
CREATE TRIGGER user_devices_pair_clears_routine_computer AFTER INSERT OR DELETE ON user_devices
FOR EACH ROW EXECUTE FUNCTION clear_routine_computer_on_device_change();
DROP TRIGGER IF EXISTS user_devices_revoke_clears_routine_computer ON user_devices;
CREATE TRIGGER user_devices_revoke_clears_routine_computer AFTER UPDATE OF "revokedAt" ON user_devices
FOR EACH ROW WHEN (OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL)
EXECUTE FUNCTION clear_routine_computer_on_device_change();
