-- Additive: signals on the realtime channel replace per-second lease reads. Older releases
-- ignore topics they do not subscribe to. Topics match `runLeaseTopic` and
-- `computerLeaseTopic` in packages/db/src/runs/lease-signals.ts.
CREATE OR REPLACE FUNCTION signal_lease_topic(topic text) RETURNS void
LANGUAGE sql AS $signal$
  SELECT pg_notify('rakazo_events', json_build_object('topic', topic, 'payload', '')::text);
$signal$;

-- A running attempt stops when its run is cancelled, recovered by another attempt, or its
-- takeover is released.
CREATE OR REPLACE FUNCTION signal_run_lease_change() RETURNS trigger
LANGUAGE plpgsql AS $run$
BEGIN
  PERFORM signal_lease_topic('run-lease:' || OLD.id);
  RETURN NULL;
END;
$run$;
DROP TRIGGER IF EXISTS runs_lease_change_signal ON runs;
CREATE TRIGGER runs_lease_change_signal AFTER UPDATE ON runs
FOR EACH ROW WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  OR OLD."leaseOwner" IS DISTINCT FROM NEW."leaseOwner"
  OR OLD."leaseFence" IS DISTINCT FROM NEW."leaseFence"
  OR (NEW.checkpoint IN ('takeover', 'takeover-skipped')
      AND OLD.checkpoint IS DISTINCT FROM NEW.checkpoint)
) EXECUTE FUNCTION signal_run_lease_change();
DROP TRIGGER IF EXISTS runs_delete_lease_signal ON runs;
CREATE TRIGGER runs_delete_lease_signal AFTER DELETE ON runs
FOR EACH ROW EXECUTE FUNCTION signal_run_lease_change();

-- A run waiting for its bot's computer looks again when the computer may have become free.
CREATE OR REPLACE FUNCTION signal_computer_lease_released() RETURNS trigger
LANGUAGE plpgsql AS $lease$
BEGIN
  PERFORM signal_lease_topic('computer-lease:' || OLD."computerId");
  RETURN NULL;
END;
$lease$;
DROP TRIGGER IF EXISTS computer_execution_leases_release_signal ON computer_execution_leases;
CREATE TRIGGER computer_execution_leases_release_signal AFTER UPDATE ON computer_execution_leases
FOR EACH ROW WHEN (NEW."expiresAt" < OLD."expiresAt")
EXECUTE FUNCTION signal_computer_lease_released();
DROP TRIGGER IF EXISTS computer_execution_leases_delete_signal ON computer_execution_leases;
CREATE TRIGGER computer_execution_leases_delete_signal AFTER DELETE ON computer_execution_leases
FOR EACH ROW EXECUTE FUNCTION signal_computer_lease_released();

CREATE OR REPLACE FUNCTION signal_computer_maintenance_end() RETURNS trigger
LANGUAGE plpgsql AS $computer$
BEGIN
  PERFORM signal_lease_topic('computer-lease:' || OLD.id);
  RETURN NULL;
END;
$computer$;
DROP TRIGGER IF EXISTS computers_maintenance_end_signal ON computers;
CREATE TRIGGER computers_maintenance_end_signal AFTER UPDATE ON computers
FOR EACH ROW WHEN (OLD."maintenanceId" IS NOT NULL AND NEW."maintenanceId" IS NULL)
EXECUTE FUNCTION signal_computer_maintenance_end();

CREATE OR REPLACE FUNCTION signal_bot_computer_change() RETURNS trigger
LANGUAGE plpgsql AS $bot$
BEGIN
  IF OLD."computerId" IS NOT NULL THEN
    PERFORM signal_lease_topic('computer-lease:' || OLD."computerId");
  END IF;
  RETURN NULL;
END;
$bot$;
DROP TRIGGER IF EXISTS bots_computer_change_signal ON bots;
CREATE TRIGGER bots_computer_change_signal AFTER UPDATE ON bots
FOR EACH ROW WHEN (
  (OLD."computerSwitching" AND NOT NEW."computerSwitching")
  OR OLD."computerId" IS DISTINCT FROM NEW."computerId"
  OR (OLD."archivedAt" IS NULL AND NEW."archivedAt" IS NOT NULL)
) EXECUTE FUNCTION signal_bot_computer_change();
