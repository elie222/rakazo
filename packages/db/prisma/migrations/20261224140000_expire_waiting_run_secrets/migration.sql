-- Runs already waiting on an answer when this release starts were scheduled for the stuck-work
-- cancel, which no longer ends questions. Pauses from now on queue their own run.forget-secrets
-- job; give these one too, so a run that holds a login or code of its own still ends a day after
-- it paused. The job leaves a run without one waiting. A job already queued is kept.
-- Fresh installations create Graphile's schema after application migrations, and have no runs.
DO $$ BEGIN
  IF to_regnamespace('graphile_worker') IS NULL THEN
    RETURN;
  END IF;
  PERFORM graphile_worker.add_job(
    'run.forget-secrets',
    json_build_object('runId', r.id),
    run_at => GREATEST(now(), (r."updatedAt" AT TIME ZONE 'UTC') + interval '1 day'),
    job_key => 'run.forget-secrets:' || r.id,
    job_key_mode => 'unsafe_dedupe'
  )
  FROM runs AS r
  WHERE r.status = 'waiting_input';
END $$;
