-- Keep the calendar handle and its cleanup job in the same transaction as the departure.
-- afterSpaceDeparture starts the sync directly and uses this same job key.
CREATE FUNCTION schedule_departed_calendar_disconnect() RETURNS trigger
LANGUAGE plpgsql AS $departure$
DECLARE
  connection_id TEXT;
BEGIN
  UPDATE meeting_calendar_connections
    SET disconnecting = true
    WHERE "spaceId" = OLD."spaceId" AND "userId" = OLD."userId" AND NOT disconnecting
    RETURNING id INTO connection_id;

  IF connection_id IS NOT NULL AND to_regnamespace('graphile_worker') IS NOT NULL THEN
    PERFORM graphile_worker.add_job(
      'meeting.calendar-sync',
      json_build_object('connectionId', connection_id),
      queue_name => 'meeting-calendar:' || connection_id,
      run_at => now() + interval '65 seconds',
      job_key => 'meeting-calendar:disconnect:' || connection_id
    );
  END IF;
  RETURN OLD;
END;
$departure$;

CREATE TRIGGER space_members_schedule_calendar_disconnect
AFTER DELETE ON space_members
FOR EACH ROW EXECUTE FUNCTION schedule_departed_calendar_disconnect();
