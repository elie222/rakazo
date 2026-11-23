-- deferred
-- Every release now sets wakeAt whenever it requeues a run, so the trigger that gave runs from
-- releases that did not a retry delay has nothing left to cover.
DROP TRIGGER IF EXISTS runs_legacy_retry_wake ON runs;
DROP FUNCTION IF EXISTS preserve_legacy_run_retry_wake();
