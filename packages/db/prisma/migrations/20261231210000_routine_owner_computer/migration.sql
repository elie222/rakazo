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
