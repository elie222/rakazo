-- A routine can send each finished run's reply to its owner's linked chat app.
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "sendToChat" BOOLEAN NOT NULL DEFAULT false;

-- Such a run gets the same backup reply job as a chat run, scheduled in the transaction that ends
-- it. A trigger's WHEN cannot read another table, so the function skips a routine run whose
-- routine does not send to chat. That is read as the table owner, so the answer never depends on
-- the Space the ending transaction runs in. Fresh installations create Graphile's schema after
-- application migrations.
CREATE OR REPLACE FUNCTION app_routine_sends_to_chat(routine_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT coalesce(
      (SELECT "sendToChat" FROM public.routines WHERE id = routine_id),
      false
    )
  $$;
CREATE OR REPLACE FUNCTION schedule_run_reply_delivery() RETURNS trigger
LANGUAGE plpgsql AS $reply$
BEGIN
  IF NEW.trigger = 'routine' AND NOT app_routine_sends_to_chat(NEW."routineId") THEN
    RETURN NEW;
  END IF;
  IF to_regnamespace('graphile_worker') IS NOT NULL THEN
    PERFORM graphile_worker.add_job(
      'messaging.reply',
      json_build_object('runId', NEW.id),
      run_at => CASE WHEN NEW.status = 'cancelled' THEN now() ELSE now() + interval '90 seconds' END,
      job_key => 'messaging.reply:' || NEW.id
    );
  END IF;
  RETURN NEW;
END;
$reply$;
DROP TRIGGER IF EXISTS runs_schedule_reply_delivery ON runs;
CREATE TRIGGER runs_schedule_reply_delivery AFTER UPDATE OF status ON runs
FOR EACH ROW
WHEN (
  NEW.status IS DISTINCT FROM OLD.status
  AND NEW.status IN ('completed', 'failed', 'cancelled')
  AND NEW.trigger IN ('messaging', 'bot_message', 'helper_result', 'routine')
)
EXECUTE FUNCTION schedule_run_reply_delivery();
