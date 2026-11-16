-- Delegated results use the same durable reply delivery as their originating conversation.
DROP TRIGGER IF EXISTS runs_schedule_reply_delivery ON runs;
CREATE TRIGGER runs_schedule_reply_delivery AFTER UPDATE OF status ON runs
FOR EACH ROW
WHEN (
  NEW.status IS DISTINCT FROM OLD.status
  AND NEW.status IN ('completed', 'failed', 'cancelled')
  AND NEW.trigger IN ('messaging', 'bot_message', 'helper_result')
)
EXECUTE FUNCTION schedule_run_reply_delivery();
